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
  MatchStake,
  MissionTemplateInput,
  MatchRoomSnapshot,
  MissionTemplateSnapshot,
  PlayerMissionProgressSnapshot,
  PlayerPublicProfileSnapshot,
  PrivateRoomSnapshot,
  Team,
  GuestContactMessageListItem,
  SupportMessageSnapshot,
  SupportConversationSnapshot,
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
import type { MonitoringSnapshot, MonitoringHistoryResult, HistoryWindow, WsConnectionsResult, ActiveRoomSnapshot } from '../adminServer/adminServerTypes'
import { isBotsOnlyActiveRoom, isStaleActiveRoom } from '../adminServer/adminServerTypes'
import { renderPeakCards, renderPeakMoments, renderHistoryInfoRow, getWindowLabel } from '../adminServer/renderAdminHistory'
import type { PlayerAccountRole, PlayerProfileFriendshipAction } from '../../ui/overlays/renderPlayerProfilePopup'
import { renderPlayerProfilePopup } from '../../ui/overlays/renderPlayerProfilePopup'
import { isPhoneLayoutViewport } from '../../ui/layout/viewportStage'
import { PUBLIC_LEGAL_PAGES, type PublicLegalPageKey } from './publicLegalPages'
import {
  PRIVATE_ROOM_POPUP_STYLES,
  renderPrivateRoomBlockedPopup,
  renderPrivateRoomInviteFriendsPopup,
  renderPrivateRoomJoinConfirmPopup,
  type PrivateRoomInviteEligibleFriend,
} from './privateRoomPopupMarkup'
import { renderRulesPage } from './renderRulesPage'
import { renderStrategyPage } from './renderStrategyPage'
import { renderLearnPage } from './renderLearnPage'
import { renderFaqPage } from './renderFaqPage'
import { renderAboutPage } from './renderAboutPage'
import { renderFairPlayPage } from './renderFairPlayPage'
import {
  type DecodedProfileImageFile,
  decodeProfileImageFile,
} from '../profileImages/profileImageUploadHelpers'
import {
  calculateContainedImageRect,
  createSquareCropFromDrag,
  displayCropToNaturalCrop,
  isPointInsideCrop,
  moveSquareCrop,
  toImageLocalPoint,
  type CropImageRect,
  type CropPoint,
  type DisplayCropSelection,
} from '../profileImages/profileImageCropGeometry'
import { orderPlayersForViewer } from './orderPlayersForViewer'
import { computePaginationItems } from './computePaginationItems'
import {
  getProfileDisplayNameAvailabilityQuery,
  validateProfileDisplayName,
  type ProfileDisplayNameValidationOptions,
} from './profileDisplayNameValidation'
import type { AdminPaymentPeriod, AdminPaymentListRow, AdminPaymentDetailRow } from '../adminPayments/adminPaymentsTypes'
import { renderAdminPaymentsPanel, attachAdminPaymentsPanelHandlers } from '../adminPayments/renderAdminPaymentsPanel'
import { renderAdminPaymentDetailPanel, attachAdminPaymentDetailHandlers } from '../adminPayments/renderAdminPaymentDetailPanel'
import type { AdminTournamentDetailRow, AdminTournamentFilters, AdminTournamentSummaryRow } from '../adminTournaments/adminTournamentTypes'
import { renderAdminTournamentDetailPanel, renderAdminTournamentsPanel, attachAdminTournamentsHandlers } from '../adminTournaments/renderAdminTournamentsPanel'
import {
  renderTournamentsScreen,
  renderTournamentDetailScreen,
  renderTournamentHowItWorksPage,
  extractTournamentCreateInputFromForm,
} from './renderTournamentsScreen'
import { renderTopicsScreen, renderAdminTopicReportsPanel, LAFCHE_TOPIC_ID, renderTopicMessageRow, renderLafcheMessageRow, renderTopicReplyRow, formatTopicUnreadBadgeCount, renderTopicLikeButton } from './renderTopicsScreen'
import { renderGuestTrialPopup, attachGuestTrialPopupEventListeners, type GuestTrialPopupState } from './renderGuestTrialPopup'
import { renderGuestLockedStakePopup, attachGuestLockedStakePopupEventListeners, type GuestLockedStakePopupState } from './renderGuestLockedStakePopup'
import { renderLevelLockedStakePopup, attachLevelLockedStakePopupEventListeners, type LevelLockedStakePopupState } from './renderLevelLockedStakePopup'

// Каноничната desktop content ширина за целия сайт — вече ползвана от
// renderNav() (виж по-долу) и non-topics content wrapper-а (desktop клона на
// root render-а). UI polish pass (Topics width): Topics content wrapper-ът
// вече consumnира СЪЩАТА константа, вместо отделно hardcode-нато число, за да
// не могат двете стойности да се разминат при бъдеща промяна.
const PIKA_DESKTOP_CONTENT_MAX_WIDTH_PX = 1640

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

export type LobbyAuthModalMode = 'closed' | 'cta' | 'login' | 'register' | 'forgot-password' | 'lobby-chat-guest'

let _persistentAvatarInput: HTMLInputElement | null = null
let _persistentGalleryInput: HTMLInputElement | null = null
let _pendingGalleryItems: Array<{ file: File; crop: AvatarCropSelection; dataUrl: string }> = []
let _pendingAvatarFile: File | null = null
let _pendingAvatarCrop: AvatarCropSelection | null = null
let _pendingAvatarPreviewDataUrl: string | null = null

// Брояч на реални извиквания на пълния Lobby render (root.innerHTML rebuild)
// — test-only observability, ползван от regression теста за Edit↔Profile
// overlay прехода, за да докаже, че renderPopupOnly()-базираните преходи
// НЕ минават през тук (виж onProfileEditClose/submitProfileEdit в
// createLobbyFlowController.ts). Не влияе на production поведение.
let _renderLobbyScreenCallCount = 0
export function getRenderLobbyScreenCallCount(): number {
  return _renderLobbyScreenCallCount
}

export function clearProfileEditorPendingState(): void {
  _pendingGalleryItems = []
  _pendingAvatarFile = null
  _pendingAvatarCrop = null
  _pendingAvatarPreviewDataUrl = null
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

function setupSquareCropInteraction(input: {
  box: HTMLElement
  image: HTMLImageElement
  selection: HTMLElement
  onCropChange: (crop: AvatarCropSelection | null) => void
}): void {
  type InteractionState =
    | { mode: 'idle' }
    | { mode: 'draw'; pointerId: number; start: CropPoint }
    | { mode: 'move'; pointerId: number; offset: CropPoint; crop: DisplayCropSelection }

  let state: InteractionState = { mode: 'idle' }
  let displayCrop: DisplayCropSelection | null = null

  function getImageRect(): CropImageRect | null {
    const boxRect = input.box.getBoundingClientRect()
    return calculateContainedImageRect({
      containerWidth: boxRect.width,
      containerHeight: boxRect.height,
      naturalWidth: input.image.naturalWidth,
      naturalHeight: input.image.naturalHeight,
    })
  }

  function getBoxPoint(event: PointerEvent): CropPoint {
    const boxRect = input.box.getBoundingClientRect()
    return {
      x: event.clientX - boxRect.left,
      y: event.clientY - boxRect.top,
    }
  }

  function renderCrop(crop: DisplayCropSelection | null, imageRect: CropImageRect | null = getImageRect()): void {
    if (crop === null || imageRect === null) {
      input.selection.style.display = 'none'
      input.onCropChange(null)
      return
    }

    input.selection.style.display = 'block'
    input.selection.style.left = `${imageRect.left + crop.left}px`
    input.selection.style.top = `${imageRect.top + crop.top}px`
    input.selection.style.width = `${crop.size}px`
    input.selection.style.height = `${crop.size}px`
    input.onCropChange(displayCropToNaturalCrop({
      crop,
      imageRect,
      naturalWidth: input.image.naturalWidth,
      naturalHeight: input.image.naturalHeight,
    }))
  }

  function updateCursor(event: PointerEvent): void {
    if (state.mode === 'move') {
      input.box.style.cursor = 'grabbing'
      return
    }

    const imageRect = getImageRect()
    if (imageRect === null) {
      input.box.style.cursor = 'default'
      return
    }

    const imagePoint = toImageLocalPoint(getBoxPoint(event), imageRect)
    input.box.style.cursor = imagePoint !== null && displayCrop !== null && isPointInsideCrop(imagePoint, displayCrop)
      ? 'grab'
      : 'crosshair'
  }

  input.box.addEventListener('pointerdown', (event) => {
    const imageRect = getImageRect()
    if (imageRect === null) return
    const point = toImageLocalPoint(getBoxPoint(event), imageRect)
    if (point === null) return

    event.preventDefault()
    input.box.setPointerCapture(event.pointerId)
    if (displayCrop !== null && isPointInsideCrop(point, displayCrop)) {
      state = {
        mode: 'move',
        pointerId: event.pointerId,
        offset: {
          x: point.x - displayCrop.left,
          y: point.y - displayCrop.top,
        },
        crop: displayCrop,
      }
      input.box.style.cursor = 'grabbing'
      return
    }

    state = { mode: 'draw', pointerId: event.pointerId, start: point }
    displayCrop = null
    renderCrop(null, imageRect)
  })

  input.box.addEventListener('pointermove', (event) => {
    if (state.mode === 'idle') {
      updateCursor(event)
      return
    }
    if (state.pointerId !== event.pointerId) return

    const imageRect = getImageRect()
    if (imageRect === null) return
    const point = toImageLocalPoint(getBoxPoint(event), imageRect)
    if (point === null && state.mode === 'draw') {
      event.preventDefault()
      const clampedBoxPoint = getBoxPoint(event)
      const clampedImagePoint = {
        x: Math.max(0, Math.min(imageRect.width, clampedBoxPoint.x - imageRect.left)),
        y: Math.max(0, Math.min(imageRect.height, clampedBoxPoint.y - imageRect.top)),
      }
      displayCrop = createSquareCropFromDrag({
        start: state.start,
        current: clampedImagePoint,
        imageRect,
      })
      renderCrop(displayCrop, imageRect)
      return
    }

    if (point === null && state.mode === 'move') {
      event.preventDefault()
      const clampedBoxPoint = getBoxPoint(event)
      const clampedImagePoint = {
        x: Math.max(0, Math.min(imageRect.width, clampedBoxPoint.x - imageRect.left)),
        y: Math.max(0, Math.min(imageRect.height, clampedBoxPoint.y - imageRect.top)),
      }
      displayCrop = moveSquareCrop({
        crop: state.crop,
        pointer: clampedImagePoint,
        offset: state.offset,
        imageRect,
      })
      renderCrop(displayCrop, imageRect)
      return
    }

    if (point === null) return

    event.preventDefault()
    displayCrop = state.mode === 'draw'
      ? createSquareCropFromDrag({ start: state.start, current: point, imageRect })
      : moveSquareCrop({ crop: state.crop, pointer: point, offset: state.offset, imageRect })
    renderCrop(displayCrop, imageRect)
  })

  function stopInteraction(event: PointerEvent): void {
    if (state.mode !== 'idle' && state.pointerId === event.pointerId) {
      if (input.box.hasPointerCapture(event.pointerId)) input.box.releasePointerCapture(event.pointerId)
      state = { mode: 'idle' }
      updateCursor(event)
    }
  }

  input.box.addEventListener('pointerup', stopInteraction)
  input.box.addEventListener('pointercancel', stopInteraction)
  window.addEventListener('resize', () => renderCrop(displayCrop))
}

export type GuestContactFormInput = {
  name: string
  email: string
  subject: string
  message: string
  website: string
}

export type LobbyScreenState = {
  /** Established API origin resolver (main.ts getApiBaseUrl) — виж коментара в createLobbyFlowController.ts за пълния rationale. Prefix-ва се пред protected attachment view/download/viewer URL-и (chat/support/topics), за да не се resolve-ват спрямо Vite dev origin-а (:5173) в local dev split-origin setup. */
  apiBaseUrl: string
  view: 'tables' | 'players' | 'friends' | 'chat' | 'leaderboards' | 'shop' | 'admin' | 'admin-info' | 'admin-server' | 'admin-visitors' | 'admin-payments' | 'admin-payment-detail' | 'admin-tournaments' | 'admin-tournament-detail' | 'tournaments' | 'tournament-detail' | 'tournament-how-it-works' | 'guest-contact-messages' | 'private-rooms' | 'support' | 'topics' | PublicLegalPageKey | 'rules' | 'strategy' | 'learn' | 'faq' | 'about' | 'fair-play'
  topicsLoading: boolean
  topicsErrorText: string | null
  topics: TopicSnapshot[] | null
  activeTopicId: string | null
  topicsMode: 'topics' | 'thread' | 'personal'
  topicsPersonalView: 'list' | 'conversation'
  topicMessagesLoading: boolean
  topicMessagesErrorText: string | null
  topicMessages: TopicMessageSnapshot[] | null
  topicMessagesHasMore: boolean
  topicMessagesOldestSeq: number | null
  topicOlderMessagesLoading: boolean
  topicMessagesRenderReason: 'initial' | 'prepend' | 'live-append' | 'reconnect-refresh' | 'own-message' | 'reorder' | null
  topicMessagesScrollAnchor: { messageId: string; top: number } | null
  topicThreadRootMessageId: string | null
  topicThreadReturnScrollAnchor: { messageId: string; top: number } | null
  topicThreadRenderReason: 'initial' | 'live-append' | 'own-reply' | null
  topicComposerDraftByTopicId: Record<string, string>
  topicComposerPendingRequestIdByTopicId: Record<string, string | null>
  topicComposerErrorTextByTopicId: Record<string, string | null>
  topicComposerPendingImageByTopicId: Record<string, { file: File; previewUrl: string } | undefined>
  topicExpandedReplyRootIds: string[]
  topicRepliesByRootId: Record<string, TopicReplySnapshot[] | null>
  topicRepliesHasMoreByRootId: Record<string, boolean>
  topicRepliesLoadingByRootId: Record<string, boolean>
  topicReplyComposerDraftByRootId: Record<string, string>
  topicReplyComposerPendingRequestIdByRootId: Record<string, string | null>
  topicReplyComposerErrorTextByRootId: Record<string, string | null>
  topicReplyComposerOpenRootId: string | null
  topicReplyComposerPendingImageByRootId: Record<string, { file: File; previewUrl: string } | undefined>
  imageViewer: { viewUrl: string; downloadUrl: string; historyPushed: boolean } | null
  topicMessageLikeCountById: Record<string, number>
  topicMessageViewerHasLikedById: Record<string, boolean>
  topicMessageLikePendingRequestIdById: Record<string, string | null>
  topicsVipGate: { isActive: boolean; hasClaimedLaunchGift: boolean } | null
  topicsVipGateLoading: boolean
  topicsVipPopupOpen: boolean
  topicsVipClaimSubmitting: boolean
  topicsVipClaimErrorText: string | null
  topicsVipSeePlansMessageVisible: boolean
  topicsInfoToast: { text: string } | null
  topicsPersonalMessagePendingProfileId: string | null
  // Pending compose context за нов vip_dm БЕЗ persistent friendshipId —
  // виж §7 в task spec-а (createLobbyFlowController.ts за пълния rationale).
  topicsPersonalPendingRecipient: { profileId: string; displayName: string } | null
  topicCreatePopupOpen: boolean
  topicCreateBusy: boolean
  topicCreateErrorText: string | null
  topicCreateTitleDraft: string
  // ─── Topics Moderation (Етап 4) ──────────────────────────────────────────
  activeTopicLock: TopicLockSnapshot | null
  activeTopicViewerMute: TopicMuteSnapshot | null
  topicsSectionMutePopupOpen: boolean
  topicModerationActionPopup:
    | { kind: 'lock'; topicId: string; topicTitle: string }
    | {
        kind: 'mute'
        topicId: string
        targetProfileId: string
        targetDisplayName: string
        sourceMessageId: string | null
        sourceKind: 'lafche_post' | 'topic_root' | 'topic_reply' | 'unspecified'
      }
    | { kind: 'unmute'; topicId: string; targetProfileId: string; targetDisplayName: string; mutedUntil: string | null; reason: string | null }
    | null
  topicModerationActionDurationMs: number | null
  topicModerationActionReason: string
  topicModerationActionReasonCategory: 'insults' | 'provocation' | 'spam' | 'inappropriate_content' | 'other' | null
  topicMuteStatusLoadingProfileId: string | null
  topicMuteHistoryPopupOpen: boolean
  topicMuteHistoryEntries: TopicMuteEvidenceSelfEntry[] | null
  topicMuteHistoryLoading: boolean
  topicMuteHistoryErrorText: string | null
  topicMuteHistoryModeratorTargetProfileId: string | null
  topicMuteHistoryModeratorEntries: TopicMuteEvidenceModeratorEntry[] | null
  topicMuteHistoryModeratorLoading: boolean
  topicMuteHistoryModeratorErrorText: string | null
  topicModerationActionBusy: boolean
  topicModerationActionErrorText: string | null
  topicDeleteConfirm: { topicId: string; topicTitle: string; step: 'reason' | 'confirm' } | null
  topicDeleteReason: string
  topicDeleteBusy: boolean
  topicDeleteErrorText: string | null
  /** Individual root съобщение/reply moderation delete confirm popup — single-step (без reason поле, за разлика от topicDeleteConfirm). isRoot определя кой предупредителен текст се показва (root: "и всички отговори", reply: само отговора). */
  topicMessageDeleteConfirm: { topicId: string; messageId: string; isRoot: boolean; isModeratorAction: boolean } | null
  topicMessageDeleteBusy: boolean
  topicMessageDeleteErrorText: string | null
  topicMessageEdit: { topicId: string; messageId: string; draft: string } | null
  topicMessageEditBusy: boolean
  topicMessageEditErrorText: string | null
  topicReportPopupOpen: boolean
  topicReportReason: string
  topicReportBusy: boolean
  topicReportErrorText: string | null
  topicReportSuccessToast: boolean
  adminTopicReportsPopupOpen: boolean
  adminTopicReportsLoading: boolean
  adminTopicReportsErrorText: string | null
  adminTopicReports: TopicReportSnapshot[] | null
  adminTopicReportsPendingCount: number
  adminTopicReportsFilter: TopicReportStatus | null
  adminTopicReportActionBusyId: string | null
  /** Client-side UX gate (server е authoritative на всяко HTTP moderation действие) — виж isTopicModeratorAuthSession в createLobbyFlowController.ts. Покрива mute/unmute/reports/audit UI. */
  isTopicModerator: boolean
  /** По-тесен client-side UX gate за whole-topic Lock/Unlock/Delete контроли — виж isTopicWholeTopicModeratorAuthSession в createLobbyFlowController.ts. */
  isWholeTopicModerator: boolean
  /** Client-side UX gate за individual root съобщение/reply moderation delete (5 роли, вкл. chat_admin) — виж isTopicMessageModeratorAuthSession в createLobbyFlowController.ts. Различен role set от isTopicModerator. */
  isTopicMessageModerator: boolean
  /** Client-side UX gate за "Лафче" (topic-lafche) delete+mute — admin/pika_team/top_chat_admin, БЕЗ subadmin/chat_admin. Виж isLafcheModeratorAuthSession в createLobbyFlowController.ts. Server е authoritative (isLafcheModeratorSession в authStore.ts, branch по topicId==='topic-lafche'). */
  isLafcheModerator: boolean
  blockedPlayersPopupOpen: boolean
  blockedPlayers: PlayerPublicProfileSnapshot[] | null
  blockedPlayersLoading: boolean
  blockedPlayersErrorText: string | null
  blockedPlayersLimit: number
  blockLimitPopupOpen: boolean
  profileAccessBlockPopup: { profileId: string; code: 'profile_blocked_by_viewer' | 'profile_blocked_viewer' } | null
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
  /**
   * ISO дата на изтичане на собствения VIP (authoritative active_until) —
   * пропагира се към renderPlayerProfilePopup САМО когато popup-ът реално
   * показва собствения профил (виж syncProfilePopup wiring-а по-долу).
   */
  ownVipActiveUntil: string | null
  /** Роля на разглеждания акаунт — само за isAdmin (пълен) viewer; виж renderPlayerProfilePopup. */
  profilePopupTargetRole: PlayerAccountRole | null
  /** "Дай VIP" inline grant форма в чужд profile popup — само за пълен admin. */
  vipGrantOpen: boolean
  vipGrantSubmitting: boolean
  vipGrantErrorText: string | null
  /**
   * previousRole: ако назначаваме субадмин, докато акаунтът реално е
   * chat_admin (или обратно за chatAdminActionConfirm по-долу) — само за
   * "старата роля ще бъде заменена" текст в confirm попъпа.
   */
  subadminActionConfirm: { profileId: string; displayName: string; action: 'grant' | 'revoke'; previousRole?: 'chat_admin' | 'pika_team' | 'top_chat_admin' | null } | null
  subadminActionBusy: boolean
  subadminActionToast: { text: string; ok: boolean } | null
  /** Огледално на subadminActionConfirm/Busy/Toast, но за chat_admin роля. */
  chatAdminActionConfirm: { profileId: string; displayName: string; action: 'grant' | 'revoke'; previousRole?: 'subadmin' | 'pika_team' | 'top_chat_admin' | null } | null
  chatAdminActionBusy: boolean
  chatAdminActionToast: { text: string; ok: boolean } | null
  pikaTeamActionConfirm: { profileId: string; displayName: string; action: 'grant' | 'revoke'; previousRole?: 'subadmin' | 'chat_admin' | 'top_chat_admin' | null } | null
  pikaTeamActionBusy: boolean
  pikaTeamActionToast: { text: string; ok: boolean } | null
  topChatAdminActionConfirm: { profileId: string; displayName: string; action: 'grant' | 'revoke'; previousRole?: 'subadmin' | 'chat_admin' | 'pika_team' | null } | null
  topChatAdminActionBusy: boolean
  topChatAdminActionToast: { text: string; ok: boolean } | null
  players: PlayerPublicProfileSnapshot[]
  playersPage: number
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
  /** Пълен администратор — вижда "Настройки", редакция на профили, чат с поддръжката, съобщения от гости. */
  isAdmin: boolean
  /** Admin ИЛИ subadmin — вижда "⚙ Админ" менюто (само "Информация"/"Сървър" вътре, ако не е isAdmin). */
  isAdminOrSubadmin: boolean
  /**
   * admin ИЛИ pika_team — единствено за показване на бутона "(×)" в
   * "Публикации от Pika.bg". НЕ дава достъп до нищо друго (виж isAdmin/
   * isAdminOrSubadmin по-горе за админските менюта) — сървърът презаверява
   * това право на всяко DELETE през isPikaAnnouncementAuthorSession, така
   * че скриването тук е само UX. Умишлено по-тесен от старото поведение
   * (admin/subadmin/chat_admin/pika_team/top_chat_admin) — виж §3 в
   * "Публикации от Pika.bg" брифа.
   */
  canDeleteLobbyChat: boolean
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
  showPikaSupportChatButton: boolean
  giftModalFriendshipId: string | null
  giftModalFriendName: string
  giftModalErrorText: string | null
  giftSuccessModal: { amount: number; friendName: string } | null
  giftReceivedModal: { amount: number; fromDisplayName: string } | null
  pendingGiftNotifications: Array<{ giftId: string; amount: number; fromDisplayName: string }>
  acceptanceNotifications: Array<{ friendshipId: string; fromProfileId: string; fromDisplayName: string; fromAvatarUrl: string | null }>
  acceptanceErrorText: string | null
  chatConversations: ChatConversationSnapshot[]
  chatShowArchived: boolean
  chatArchivedConversations: ChatConversationSnapshot[]
  chatArchivedLoading: boolean
  activeChatFriendshipId: string | null
  chatMessages: ChatMessageSnapshot[]
  chatMessagesFriendshipId: string | null
  chatLoading: boolean
  chatMessagesLoading: boolean
  chatErrorText: string | null
  // Незапратен текст, писан от потребителя за всеки разговор поотделно (keyed по friendshipId).
  // Пази се отделно от chatMessages, за да не се губи при re-render, предизвикан от входящо
  // съобщение, polling или друго фоново обновяване, докато потребителят пише.
  chatDraftByFriendshipId: Record<string, string>
  // Избрана-но-неизпратена снимка per разговор (keyed по friendshipId) —
  // previewUrl е object-URL (URL.createObjectURL), освобождава се explicit
  // при премахване/успешно изпращане (виж createLobbyFlowController.ts).
  chatPendingImageByFriendshipId: Record<string, { file: File; previewUrl: string } | undefined>
  chatUploadingFriendshipIds: Set<string>
  // "Публикации от Pika.bg" в лобито (бивш общ лайв чат, херо карето на
  // началния екран) — отделен поток от chatConversations/chatMessages
  // по-горе (личен 1:1 чат от раздел "ЧАТ").
  lobbyChatMessages: LobbyChatMessageSnapshot[]
  lobbyChatSubscribed: boolean
  lobbyChatDraft: string
  lobbyChatSending: boolean
  lobbyChatErrorText: string | null
  lobbyChatFullscreen: boolean
  /**
   * admin ИЛИ pika_team — единствените роли, които могат да пишат в
   * "Публикации от Pika.bg". Само UX (readonly composer + popup вместо
   * disabled бутон) — сървърът презаверява на всяко изпращане (виж
   * index.ts send_lobby_chat_message handler).
   */
  canWriteLobbyChat: boolean
  /** Popup: "Публикации от Pika.bg" — показва се при клик/tap на composer-а от потребител без право да пише. */
  lobbyChatWriteLockedPopupOpen: boolean
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
  profileEditorSubmitting: boolean
  profileNameChangeErrorText: string | null
  profileNameChangeSuccessAmount: number | null
  changePasswordPopupOpen: boolean
  changePasswordErrorText: string | null
  notificationsOpen: boolean
  privateRoomInGameNotificationsEnabled: boolean
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
  privateRoomConflictPromptOpen: boolean
  privateRoomConflictPromptVariant: 'generic' | 'list-join'
  privateRoomJoinSlotPopup: { team: Team; slotIndex: 0 | 1 } | null
  privateRoomBlockedPopupText: string | null
  inviteFriendsPopupOpen: boolean
  inviteFriends: PrivateRoomInviteEligibleFriend[] | null
  supportPopupOpen: boolean
  supportMessages: SupportMessageSnapshot[]
  supportUnreadCount: number
  supportLoading: boolean
  supportSendingLoading: boolean
  supportErrorText: string | null
  supportDraft: string
  supportPendingImage: { file: File; previewUrl: string } | null
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

export type RenderLobbyScreenOptions = {
  state: LobbyScreenState
  apiBaseUrl: string
  onDisplayNameChange: (value: string) => void
  onStakeChange: (stake: MatchStake) => void
  onSearchClick: () => void
  onCancelClick: () => void
  onProfileClick: () => void
  onProfileClose: () => void
  onProfileEditClick: (profileId: string | null) => void
  onProfileGrantSubadminClick: (profileId: string | null) => void
  onProfileRevokeSubadminClick: (profileId: string | null) => void
  onSubadminActionCancel: () => void
  onSubadminActionConfirm: () => void
  onProfileGrantChatAdminClick: (profileId: string | null) => void
  onProfileRevokeChatAdminClick: (profileId: string | null) => void
  onChatAdminActionCancel: () => void
  onChatAdminActionConfirm: () => void
  onProfileGrantPikaTeamClick: (profileId: string | null) => void
  onProfileRevokePikaTeamClick: (profileId: string | null) => void
  onPikaTeamActionCancel: () => void
  onPikaTeamActionConfirm: () => void
  onProfileGrantTopChatAdminClick: (profileId: string | null) => void
  onProfileRevokeTopChatAdminClick: (profileId: string | null) => void
  onTopChatAdminActionCancel: () => void
  onTopChatAdminActionConfirm: () => void
  onProfileVipGrantOpen: (profileId: string | null) => void
  onProfileVipGrantCancel: () => void
  onProfileVipGrantSubmit: (profileId: string | null, rawDays: string) => void
  onProfileEditClose: () => void
  onProfileEditSubmit: (
    avatarFile: File | null,
    avatarCrop: AvatarCropSelection | null,
    galleryFiles: File[],
  ) => void
  onProfileEditorFileError: (message: string | null) => void
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
  onTournamentsClick: () => void
  onTopicsClick: () => void
  onTopicsLafcheOpen: () => void
  onTopicsPersonalOpen: () => void
  onTopicsPersonalBack: () => void
  onTopicsPersonalConversationBack: () => void
  onTopicChipClick: (topicId: string) => void
  onTopicCreateClick: () => void
  onTopicCreatePopupClose: () => void
  onTopicCreateTitleInput: (value: string) => void
  onTopicCreateSubmit: () => void
  onTopicsBackToGeneral: () => void
  onTopicMessagesLoadOlder: () => void
  onTopicComposerInput: (topicId: string, value: string) => void
  onTopicComposerSubmit: (topicId: string) => void
  onTopicComposerNonVipTap: () => void
  onTopicComposerMutedTap: () => void
  onTopicComposerImageSelect: (topicId: string, file: File) => void
  onTopicComposerImageRemove: (topicId: string) => void
  onTopicRepliesLoadMore: (rootMessageId: string) => void
  onTopicThreadOpen: (rootMessageId: string, scrollAnchor?: { messageId: string; top: number } | null) => void
  onTopicThreadBack: () => void
  onTopicMessageLikeToggleClick: (messageId: string) => void
  onTopicReplyClick: (rootMessageId: string, scrollAnchor?: { messageId: string; top: number } | null) => void
  onTopicReplyComposerNonVipTap: () => void
  onTopicReplyComposerCancel: (rootMessageId: string) => void
  onTopicReplyComposerInput: (rootMessageId: string, value: string) => void
  onTopicReplyComposerSubmit: (rootMessageId: string) => void
  onTopicReplyComposerImageSelect: (rootMessageId: string, file: File) => void
  onTopicReplyComposerImageRemove: (rootMessageId: string) => void
  onImageViewerOpen: (attachment: { viewUrl: string; downloadUrl: string }) => void
  onImageViewerClose: () => void
  onTopicsVipPopupClose: () => void
  onTopicsVipPopupClaimLaunchGift: () => void
  onTopicsVipPopupSeePlans: () => void
  // ─── Topics Moderation (Етап 4) ──────────────────────────────────────────
  onTopicMuteHistoryOpen: () => void
  onTopicMuteHistoryClose: () => void
  onTopicsSectionMutePopupAcknowledge: () => void
  onTopicsSectionMutePopupHistoryOpen: () => void
  onTopicMuteHistoryOpenForProfile: (profileId: string) => void
  onTopicMuteHistoryCloseForProfile: () => void
  onTopicLockClick: (topicId: string, topicTitle: string) => void
  onTopicUnlockClick: (topicId: string) => void
  onTopicMuteClick: (
    topicId: string,
    targetProfileId: string,
    targetDisplayName: string,
    sourceMessageId?: string | null,
    sourceKind?: 'lafche_post' | 'topic_root' | 'topic_reply' | 'unspecified',
  ) => void
  onTopicUnmuteClick: (topicId: string, targetProfileId: string) => void
  onTopicModerationActionPopupClose: () => void
  onTopicModerationActionDurationChange: (durationMs: number) => void
  onTopicModerationActionReasonChange: (reason: string) => void
  onTopicModerationActionReasonCategoryChange: (category: 'insults' | 'provocation' | 'spam' | 'inappropriate_content' | 'other' | null) => void
  onTopicModerationActionSubmit: () => void
  onTopicDeleteClick: (topicId: string, topicTitle: string) => void
  onTopicDeleteConfirmClose: () => void
  onTopicDeleteReasonChange: (reason: string) => void
  onTopicDeleteAdvance: () => void
  onTopicDeleteConfirmSubmit: () => void
  onTopicMessageDeleteClick: (topicId: string, messageId: string, isRoot: boolean, isModeratorAction: boolean) => void
  onTopicMessageDeleteConfirmClose: () => void
  onTopicMessageDeleteConfirmSubmit: () => void
  onTopicMessageEditClick: (topicId: string, messageId: string) => void
  onTopicsInfoToast: (text: string) => void
  onTopicMessageEditInput: (messageId: string, value: string) => void
  onTopicMessageEditCancel: (messageId: string) => void
  onTopicMessageEditSubmit: (messageId: string) => void
  onTopicReportClick: () => void
  onTopicReportPopupClose: () => void
  onTopicReportReasonChange: (reason: string) => void
  onTopicReportSubmit: () => void
  onAdminTopicReportsFilterChange: (status: TopicReportStatus | null) => void
  onAdminTopicReportReview: (reportId: string, status: 'reviewed' | 'dismissed') => void
  onTopicMessageAuthorClick: (profileId: string, displayName: string) => void
  onTopicMessagePersonalClick: (profileId: string, displayName: string) => void
  onTournamentHowItWorksOpen: () => void
  onTournamentsFilterChange: (filter: 'all' | 'mine') => void
  onTournamentCreatePopupOpen: () => void
  onTournamentCreatePopupClose: () => void
  onTournamentCreateSubmit: (input: import('../network/createGameServerClient').TournamentCreateInput) => void
  onTournamentCardClick: (tournamentId: string) => void
  onTournamentDetailPasswordDraftChange: (value: string) => void
  onTournamentUnlockSubmit: () => void
  onTournamentJoinConfirmOpen: () => void
  onTournamentJoinConfirmClose: () => void
  onTournamentJoinSubmit: () => void
  onTournamentPartnerPickerOpen: () => void
  onTournamentPartnerPickerClose: () => void
  onTournamentPartnerInviteSubmit: (profileId: string) => void
  onTournamentPartnerInviteQueryChange: (value: string) => void
  onTournamentPartnerInviteAccept: (tournamentId: string, inviteId: string) => void
  onTournamentPartnerInviteDecline: (tournamentId: string, inviteId: string) => void
  onTournamentPartnerInviteCancel: (tournamentId: string, inviteId: string) => void
  onTournamentEnterActiveMatch: (roomId: string, reconnectToken: string) => void
  onTournamentLeaveConfirmOpen: () => void
  onTournamentLeaveConfirmClose: () => void
  onTournamentLeaveSubmit: () => void
  onTournamentCancelConfirmOpen: () => void
  onTournamentCancelConfirmClose: () => void
  onTournamentCancelSubmit: () => void
  onAdminClick: () => void
  onAdminInfoClick: () => void
  onAdminServerClick: () => void
  onAdminGuestContactMessagesClick: () => void
  onAdminTopicReportsOpen: () => void
  onAdminTopicReportsClose: () => void
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
  onAdminCoinPackageTopOfferToggle: (packageId: string, isTopOffer: boolean) => void
  onFriendsClick: () => void
  onBlockedPlayersClick: () => void
  onBlockedPlayersClose: () => void
  onUnblockClick: (profileId: string) => void
  onBlockLimitPopupClose: () => void
  onProfileAccessBlockClose: () => void
  onProfileAccessBlockUnblock: (profileId: string) => void
  onNoPlayersModalClose: () => void
  onChatClick: () => void
  onChatConversationClick: (friendshipId: string) => void
  onChatMarkRead: (friendshipId: string) => void
  onChatToggleArchived: () => void
  onChatSubmit: (friendshipId: string, body: string) => void
  onChatDraftChange: (friendshipId: string, draft: string) => void
  onChatImageSelect: (friendshipId: string, file: File) => void
  onChatImageRemove: (friendshipId: string) => void
  onPlayerCardClick: (profile: PlayerPublicProfileSnapshot) => void
  onPlayersSearchChange: (query: string) => void
  onPlayersSearchDraftChange: (draft: string) => void
  onPlayersSearchSubmit: (query: string) => void
  onPlayersPageChange: (page: number) => void
  onLeaderboardPlayerClick: (profile: PlayerPublicProfileSnapshot) => void
  onFriendProfileClick: (profile: PlayerPublicProfileSnapshot) => void
  onFriendRequestClick: (profileId: string) => void
  onBlockClick: (profileId: string) => void
  onFriendAcceptClick: (friendshipId: string) => void
  onFriendRejectClick: (friendshipId: string) => void
  onFriendCancelClick: (friendshipId: string) => void
  onFriendRemoveClick: (friendshipId: string) => void
  onGiftCoinsClick: (friendshipId: string) => void
  onPikaSupportChatClick: (profileId: string) => void
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
  onLobbyChatDraftChange: (value: string) => void
  onLobbyChatSubmit: () => void
  onLobbyChatDelete: (messageId: string) => void
  onLobbyChatFullscreenChange: (isFullscreen: boolean) => void
  onLobbyChatWriteLockedTap: () => void
  onLobbyChatWriteLockedPopupClose: () => void
  onLobbyChatWriteLockedGotoTopics: () => void
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
  onPrivateRoomInGameNotificationsChange: (enabled: boolean) => void
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
  onPrivateRoomCreate: (stake: MatchStake, isLocked: boolean, waitMinutes: 5 | 10 | 15 | 30) => void
  /** Клик върху ред в списъка — само preview navigation, не изпраща join_private_room; реалният seat claim минава през конкретния "+" на waiting-room екрана. */
  onPrivateRoomJoin: (privateRoomId: string) => void
  /** Клик върху зает seat/avatar в списъка "Частни маси" — отваря съществуващия profile popup flow (не влиза в масата). */
  onPrivateRoomMemberClick: (profileId: string, displayName: string) => void
  /** Клик върху конкретен свободен "+" на карта в списъка (не собствената маса) — отваря join-confirm popup-а за точно този (room, team, slotIndex). Ако потребителят вече седи на друга маса, контролерът показва conflict popup-а вместо да отвори join popup-а. */
  onPrivateRoomListSlotJoinOpen: (privateRoomId: string, team: Team, slotIndex: 0 | 1) => void
  /** Потвърждение на join-confirm popup-а (споделен между списъка и waiting room екрана) — изпраща реалния join_private_room. */
  onPrivateRoomJoinSlotPopupConfirm: () => void
  /** Отказ/затваряне на join-confirm popup-а — без заявка към сървъра. */
  onPrivateRoomJoinSlotPopupCancel: () => void
  /** Затваря X-only blocked-partner popup-а (споделен между списъка и waiting room екрана). */
  onPrivateRoomBlockedPopupClose: () => void
  /** "ВЛЕЗ" бутон на собствената маса в списъка — чиста навигация към вече съществуващата чакалня, без нов join. */
  onPrivateRoomListEnter: (privateRoomId: string) => void
  onPrivateRoomInvite: (toProfiles: Array<{ profileId: string; displayName: string }>) => void
  onCancelPrivateRoomInvite: (inviteId: string) => void
  onInviteFriendsOpen: () => void
  onInviteFriendsClose: () => void
  onPrivateRoomInviteSend: (profileId: string, displayName: string) => void
  onPrivateRoomInviteAccept: (inviteId: string) => void
  onPrivateRoomInviteDecline: (inviteId: string) => void
  onPrivateRoomInfoDismiss: () => void
  onPrivateRoomConflictReturnClick: () => void
  onPrivateRoomConflictDismiss: () => void
  onSupportClick: () => void
  onSupportClose: () => void
  onSupportDraftChange: (draft: string) => void
  onSupportImageSelect: (file: File) => void
  onSupportImageRemove: () => void
  onSupportSend: (body: string) => void
  onGuestContactClick: () => void
  onGuestContactClose: () => void
  onGuestContactSubmit: (input: GuestContactFormInput) => void
  onAdminSupportConversationClick: (profileId: string) => void
  onAdminSupportReplyDraftChange: (profileId: string, draft: string) => void
  onAdminSupportImageSelect: (profileId: string, file: File) => void
  onAdminSupportImageRemove: (profileId: string) => void
  onAdminSupportReply: (profileId: string, body: string) => void
  onAdminSupportDeleteClick: (profileId: string) => void
  onAdminSupportDeleteCancel: () => void
  onAdminSupportDeleteConfirm: (profileId: string) => void
  onAdminSupportMobileBack: () => void
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
  onAdminTournamentsOpen?: () => void
  onAdminTournamentsBack?: () => void
  onAdminTournamentsFilter?: (filters: Partial<AdminTournamentFilters>) => void
  onAdminTournamentsPage?: (page: number) => void
  onAdminTournamentOpen?: (tournamentId: string) => void
  onAdminTournamentReconcile?: () => void
  onAdminTournamentCancelOpen?: () => void
  onAdminTournamentCancelConfirm?: () => void
  onAdminTournamentCancelDismiss?: () => void
  onRulesOpen: () => void
  onStrategyOpen: () => void
}



const MAX_PROFILE_GALLERY_IMAGES = 6

let popupRootEl: HTMLElement | null = null
// Image viewer delegated listener-и (click + Esc) — attach-ват се ЕДИНИЧНО
// (module-level guard), не при всеки render, защото `root` е стабилен
// елемент между render-ите (само innerHTML се презаписва) — повторен
// addEventListener на всеки render би трупал duplicate handlers.
let imageViewerRootListenerAttachedFor: HTMLElement | null = null
let imageViewerEscListenerAttached = false
let latestImageViewerOpenHandler: ((attachment: { viewUrl: string; downloadUrl: string }) => void) | null = null
let latestImageViewerCloseHandler: (() => void) | null = null
// Create Topic popup Esc singleton (Custom Topic Creation) — mirror на image
// viewer Esc pattern-а по-горе.
let topicCreateEscListenerAttached = false
let latestTopicCreateCloseHandler: (() => void) | null = null
let privateRoomInfoDismissTimer: ReturnType<typeof setTimeout> | null = null
let mobileMenuOpen = false
// One-shot entrance-animation flag (mobile menu flicker fix) — true САМО
// веднага след реално closed->open user action (виж openMobileMenu()).
// Consume-ва се от renderMobileMenu() при следващия mount (изиграва
// mobile-menu-shade-in/mobile-menu-backdrop-in точно веднъж), после остава
// false през следващите background renders, докато менюто остава логически
// отворено — без това, всеки несвързан render() (напр.
// topic_unread_count_changed) би replay-нал entrance анимацията при пълния
// innerHTML remount (mobileMenuOpen сам по себе си стои true през целия
// период, затова не може да служи за този check).
let mobileMenuEntranceAnimationPending = false
let mobileMenuCloseTimer: ReturnType<typeof setTimeout> | null = null
let stakesFirstCardIndex = -1
let stakesAnimFrame = 0
let inviteCountdownTimer: ReturnType<typeof setInterval> | null = null
let savedAdminSupportMobileListScrollTop = 0
let lobbyChatBodyScrollLockPrevious: {
  bodyOverflow: string
  bodyTouchAction: string
  htmlOverscrollBehavior: string
} | null = null

function setLobbyChatBodyScrollLocked(locked: boolean): void {
  if (typeof document === 'undefined') return

  const body = document.body
  const html = document.documentElement

  if (locked) {
    if (lobbyChatBodyScrollLockPrevious !== null) return
    lobbyChatBodyScrollLockPrevious = {
      bodyOverflow: body.style.overflow,
      bodyTouchAction: body.style.touchAction,
      htmlOverscrollBehavior: html.style.overscrollBehavior,
    }
    body.style.overflow = 'hidden'
    body.style.touchAction = 'none'
    html.style.overscrollBehavior = 'none'
    return
  }

  if (lobbyChatBodyScrollLockPrevious === null) return
  body.style.overflow = lobbyChatBodyScrollLockPrevious.bodyOverflow
  body.style.touchAction = lobbyChatBodyScrollLockPrevious.bodyTouchAction
  html.style.overscrollBehavior = lobbyChatBodyScrollLockPrevious.htmlOverscrollBehavior
  lobbyChatBodyScrollLockPrevious = null
}

export function releaseLobbyChatBodyScrollLock(): void {
  setLobbyChatBodyScrollLocked(false)
}

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
  onPikaSupportChatClick: (profileId: string) => void
  onTopicsPersonalMessageClick: (profileId: string) => void
  onLikeClick: (profileId: string) => void
  onGrantSubadminClick: (profileId: string | null) => void
  onRevokeSubadminClick: (profileId: string | null) => void
  onGrantChatAdminClick: (profileId: string | null) => void
  onRevokeChatAdminClick: (profileId: string | null) => void
  onGrantPikaTeamClick: (profileId: string | null) => void
  onRevokePikaTeamClick: (profileId: string | null) => void
  onGrantTopChatAdminClick: (profileId: string | null) => void
  onRevokeTopChatAdminClick: (profileId: string | null) => void
  onVipGrantOpen: (profileId: string | null) => void
  onVipGrantCancel: () => void
  onVipGrantSubmit: (profileId: string | null, rawDays: string) => void
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
  const grantSubadminEl = el.querySelector<HTMLElement>('[data-player-profile-grant-subadmin="1"]')
  if (grantSubadminEl) {
    grantSubadminEl.addEventListener('click', () => {
      cb.onGrantSubadminClick(profileId)
    })
    grantSubadminEl.addEventListener('mouseenter', () => { grantSubadminEl.style.textDecoration = 'underline' })
    grantSubadminEl.addEventListener('mouseleave', () => { grantSubadminEl.style.textDecoration = 'none' })
  }
  const revokeSubadminEl = el.querySelector<HTMLElement>('[data-player-profile-revoke-subadmin="1"]')
  if (revokeSubadminEl) {
    revokeSubadminEl.addEventListener('click', () => {
      cb.onRevokeSubadminClick(profileId)
    })
    revokeSubadminEl.addEventListener('mouseenter', () => { revokeSubadminEl.style.textDecoration = 'underline' })
    revokeSubadminEl.addEventListener('mouseleave', () => { revokeSubadminEl.style.textDecoration = 'none' })
  }
  const grantChatAdminEl = el.querySelector<HTMLElement>('[data-player-profile-grant-chat-admin="1"]')
  if (grantChatAdminEl) {
    grantChatAdminEl.addEventListener('click', () => {
      cb.onGrantChatAdminClick(profileId)
    })
    grantChatAdminEl.addEventListener('mouseenter', () => { grantChatAdminEl.style.textDecoration = 'underline' })
    grantChatAdminEl.addEventListener('mouseleave', () => { grantChatAdminEl.style.textDecoration = 'none' })
  }
  const revokeChatAdminEl = el.querySelector<HTMLElement>('[data-player-profile-revoke-chat-admin="1"]')
  if (revokeChatAdminEl) {
    revokeChatAdminEl.addEventListener('click', () => {
      cb.onRevokeChatAdminClick(profileId)
    })
    revokeChatAdminEl.addEventListener('mouseenter', () => { revokeChatAdminEl.style.textDecoration = 'underline' })
    revokeChatAdminEl.addEventListener('mouseleave', () => { revokeChatAdminEl.style.textDecoration = 'none' })
  }
  const grantPikaTeamEl = el.querySelector<HTMLElement>('[data-player-profile-grant-pika-team="1"]')
  if (grantPikaTeamEl) {
    grantPikaTeamEl.addEventListener('click', () => {
      cb.onGrantPikaTeamClick(profileId)
    })
    grantPikaTeamEl.addEventListener('mouseenter', () => { grantPikaTeamEl.style.textDecoration = 'underline' })
    grantPikaTeamEl.addEventListener('mouseleave', () => { grantPikaTeamEl.style.textDecoration = 'none' })
  }
  const revokePikaTeamEl = el.querySelector<HTMLElement>('[data-player-profile-revoke-pika-team="1"]')
  if (revokePikaTeamEl) {
    revokePikaTeamEl.addEventListener('click', () => {
      cb.onRevokePikaTeamClick(profileId)
    })
    revokePikaTeamEl.addEventListener('mouseenter', () => { revokePikaTeamEl.style.textDecoration = 'underline' })
    revokePikaTeamEl.addEventListener('mouseleave', () => { revokePikaTeamEl.style.textDecoration = 'none' })
  }
  const grantTopChatAdminEl = el.querySelector<HTMLElement>('[data-player-profile-grant-top-chat-admin="1"]')
  if (grantTopChatAdminEl) {
    grantTopChatAdminEl.addEventListener('click', () => {
      cb.onGrantTopChatAdminClick(profileId)
    })
    grantTopChatAdminEl.addEventListener('mouseenter', () => { grantTopChatAdminEl.style.textDecoration = 'underline' })
    grantTopChatAdminEl.addEventListener('mouseleave', () => { grantTopChatAdminEl.style.textDecoration = 'none' })
  }
  const revokeTopChatAdminEl = el.querySelector<HTMLElement>('[data-player-profile-revoke-top-chat-admin="1"]')
  if (revokeTopChatAdminEl) {
    revokeTopChatAdminEl.addEventListener('click', () => {
      cb.onRevokeTopChatAdminClick(profileId)
    })
    revokeTopChatAdminEl.addEventListener('mouseenter', () => { revokeTopChatAdminEl.style.textDecoration = 'underline' })
    revokeTopChatAdminEl.addEventListener('mouseleave', () => { revokeTopChatAdminEl.style.textDecoration = 'none' })
  }
  const vipGrantOpenEl = el.querySelector<HTMLElement>('[data-player-profile-vip-grant-open="1"]')
  if (vipGrantOpenEl) {
    vipGrantOpenEl.addEventListener('click', () => {
      cb.onVipGrantOpen(profileId)
    })
    vipGrantOpenEl.addEventListener('mouseenter', () => { vipGrantOpenEl.style.textDecoration = 'underline' })
    vipGrantOpenEl.addEventListener('mouseleave', () => { vipGrantOpenEl.style.textDecoration = 'none' })
  }
  el.querySelector<HTMLButtonElement>('[data-player-profile-vip-grant-cancel="1"]')
    ?.addEventListener('click', () => {
      cb.onVipGrantCancel()
    })
  el.querySelector<HTMLFormElement>('[data-player-profile-vip-grant-form="1"]')
    ?.addEventListener('submit', (event) => {
      event.preventDefault()
      const rawDays = el.querySelector<HTMLInputElement>('[data-player-profile-vip-grant-input="1"]')?.value ?? ''
      cb.onVipGrantSubmit(profileId, rawDays)
    })
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
  el.querySelector<HTMLButtonElement>('[data-player-profile-pika-support-chat]')
    ?.addEventListener('click', (e) => {
      const profileId = (e.currentTarget as HTMLButtonElement).dataset.playerProfilePikaSupportChat?.trim() ?? ''
      if (profileId) cb.onPikaSupportChatClick(profileId)
    })
  el.querySelector<HTMLButtonElement>('[data-player-profile-topics-personal-message]')
    ?.addEventListener('click', (e) => {
      const profileId = (e.currentTarget as HTMLButtonElement).dataset.playerProfileTopicsPersonalMessage?.trim() ?? ''
      if (profileId) cb.onTopicsPersonalMessageClick(profileId)
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
    isOwnProfile?: boolean
    friendshipAction: PlayerProfileFriendshipAction | null
    viewerIsFullAdmin?: boolean
    targetAccountRole?: PlayerAccountRole | null
    showPikaSupportChatButton?: boolean
    showTopicsPersonalMessageButton?: boolean
    ownVipActiveUntil?: string | null
    vipGrantOpen?: boolean
    vipGrantSubmitting?: boolean
    vipGrantErrorText?: string | null
    // Форсира skipAnimation дори при "first open" (нов popupRootEl) — нужно
    // при връщане Edit→Profile: popup DOM възелът е бил унищожен, докато
    // edit overlay-ят е бил отворен отгоре му, но КОНЦЕПТУАЛНО потребителят
    // никога не е напускал profile flow-а, затова не трябва да прегражда
    // entrance fade-in анимацията (140-160ms), която за момент разкрива
    // голия Lobby зад полу-прозрачния backdrop.
    skipAnimation?: boolean
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
    isOwnProfile: popupState.isOwnProfile ?? false,
    friendshipAction: popupState.friendshipAction,
    skipAnimation: !isFirstOpen || (popupState.skipAnimation ?? false),
    viewerIsFullAdmin: popupState.viewerIsFullAdmin ?? false,
    targetAccountRole: popupState.targetAccountRole ?? null,
    ownVipActiveUntil: popupState.ownVipActiveUntil ?? null,
    showPikaSupportChatButton: popupState.showPikaSupportChatButton ?? false,
    showTopicsPersonalMessageButton: popupState.showTopicsPersonalMessageButton ?? false,
    vipGrantOpen: popupState.vipGrantOpen ?? false,
    vipGrantSubmitting: popupState.vipGrantSubmitting ?? false,
    vipGrantErrorText: popupState.vipGrantErrorText ?? null,
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

function cssEscape(value: string): string {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/["\\]/g, '\\$&')
}

function keepComposerFocusOnPointerSubmit(button: HTMLButtonElement | null): void {
  if (button === null) return
  const preserveFocus = (event: PointerEvent | MouseEvent | TouchEvent) => {
    if (button.disabled) return
    event.preventDefault()
  }
  button.addEventListener('pointerdown', preserveFocus)
}

function submitTextareaOnEnter(textarea: HTMLTextAreaElement | null): void {
  textarea?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    textarea.form?.requestSubmit()
  })
}

// Bounded auto-grow (Етап 2 Topics composer) — рязко се разширява до
// съдържанието, capped от CSS max-height (виж inline style в
// renderTopicsComposer) — composer-ът никога не поглъща целия message viewport.
function autoGrowTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return
  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight}px`
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat('bg-BG').format(value)
}

export function renderTopOfferBadge(): string {
  return `<div style="position:absolute;top:-11px;left:14px;z-index:3;display:inline-flex;align-items:center;gap:4px;background:linear-gradient(135deg,#f4c95b 0%,#c98f13 100%);color:#000000;font-size:11px;font-weight:900;letter-spacing:0.01em;padding:5px 11px;border-radius:999px;box-shadow:0 4px 10px rgba(0,0,0,0.4);white-space:nowrap;pointer-events:none;">✦ ТОП ОФЕРТА</div>`
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
    : state.authModalMode === 'lobby-chat-guest'
    ? `
      <div style="display:grid;gap:16px;text-align:center;">
        <div style="font-size:22px;line-height:1.25;font-weight:900;color:#f8fafc;">
          Общ чат само за регистрирани потребители
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
              <input name="displayName" autocomplete="nickname" data-name-check-input="register" style="width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:700;outline:none;">
            </span>
            <span data-name-hint="register" style="min-height:14px;display:block;overflow:hidden;text-overflow:ellipsis;font-size:11px;font-weight:800;line-height:1.25;letter-spacing:0;text-transform:none;pointer-events:none;white-space:nowrap;"></span>
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

/**
 * Popup: показва се, когато логнат потребител БЕЗ право да пише (не
 * admin/pika_team) кликне/tap-не composer-а или SEND бутона в "Публикации
 * от Pika.bg". Отделен от renderAuthModal (auth modal е само за гост
 * login/register CTA) — визуален стил (backdrop+card) е mirror на
 * renderAuthModal за консистентност.
 */
function renderLobbyChatWriteLockedPopup(state: LobbyScreenState): string {
  if (!state.lobbyChatWriteLockedPopupOpen) {
    return ''
  }

  return `
    <div data-lobby-livechat-write-locked-modal-root="1" style="position:fixed;inset:0;z-index:13000;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-lobby-livechat-write-locked-modal-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,440px);border-radius:8px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
        <button type="button" data-lobby-livechat-write-locked-modal-close="1" aria-label="Затвори" style="position:absolute;right:4px;top:4px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <div style="display:grid;gap:14px;text-align:center;">
          <div style="font-size:22px;line-height:1.25;font-weight:900;color:#f8fafc;">
            Публикации от Pika.bg
          </div>
          <div style="font-size:14px;line-height:1.55;color:rgba(255,255,255,0.72);font-weight:600;">
            Тази секция е предназначена само за публикации от екипа на Pika.bg.<br><br>
            Ако искате да пишете, да зададете въпрос или да започнете дискусия, използвайте секция „Теми".
          </div>
          <div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:6px;">
            <button type="button" data-lobby-livechat-write-locked-goto-topics="1" style="height:46px;min-width:150px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;">Към Теми</button>
            <button type="button" data-lobby-livechat-write-locked-modal-close="1" style="height:46px;min-width:130px;border:1px solid rgba(212,165,32,0.62);border-radius:8px;background:#080808;color:#f8fafc;font-size:15px;font-weight:900;cursor:pointer;">Затвори</button>
          </div>
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
  const isProfileEditorSubmitting = state.profileEditorSubmitting
  const avatarPreviewUrl = _pendingAvatarPreviewDataUrl ?? editorProfile.avatarUrl
  const nameChangePrice = state.profileNameChangePrice
  const isPhoneLayout = isPhoneLayoutViewport()
  const nameChangeCardStyle = isPhoneLayout
    ? 'display:grid;gap:6px;border:1px solid rgba(212,165,32,0.22);border-radius:8px;background:rgba(255,255,255,0.035);padding:8px;'
    : 'display:grid;gap:8px;border:1px solid rgba(212,165,32,0.22);border-radius:8px;background:rgba(255,255,255,0.035);padding:12px;'
  const nameChangeHeaderStyle = isPhoneLayout
    ? 'display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;'
    : 'display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;'
  const nameChangeInputStyle = `width:100%;box-sizing:border-box;height:${isPhoneLayout ? '36px' : '42px'};border-radius:8px;border:1px solid ${state.profileNameChangeErrorText ? 'rgba(248,113,113,0.60)' : 'rgba(212,165,32,0.34)'};background:#050505;color:#ffffff;padding:0 12px;font-size:${isPhoneLayout ? '14px' : '15px'};font-weight:700;outline:none;`
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
              </span>
              <span data-name-hint="namechange" style="min-height:14px;display:block;overflow:hidden;text-overflow:ellipsis;font-size:11px;font-weight:800;line-height:1.25;pointer-events:none;white-space:nowrap;"></span>
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
                ${avatarPreviewUrl
                  ? `<img src="${escapeHtml(avatarPreviewUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">`
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
            <button type="submit" ${isProfileEditorSubmitting ? 'disabled' : ''} style="height:42px;padding:0 18px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:14px;font-weight:900;cursor:${isProfileEditorSubmitting ? 'default' : 'pointer'};opacity:${isProfileEditorSubmitting ? '0.62' : '1'};">${isProfileEditorSubmitting ? 'Запазване...' : 'Запази'}</button>
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
  const tournamentsActive = activeView === 'tournaments' || activeView === 'tournament-detail'
  const topicsActive = activeView === 'topics'
  const shopActive = activeView === 'shop'
  const adminActive = activeView === 'admin' || activeView === 'admin-info' || activeView === 'admin-server' || activeView === 'admin-tournaments' || activeView === 'admin-tournament-detail' || activeView === 'guest-contact-messages'
  const lobbyActive = activeView === 'tables'
  const mailUnreadCount = getSupportUnreadRaw(state)
  const notificationsBadgeCount = getNotificationsBadgeCount(state)
  const notificationsBadge = formatNotificationBadgeCount(notificationsBadgeCount)
  const incomingFriendRequestsCount =
    state.friendships?.incomingPending.length ?? 0
  const friendChatUnreadCount = getFriendChatUnreadRaw(state)
  const friendChatUnreadBadge = formatNotificationBadgeCount(friendChatUnreadCount)
  const topicsUnreadCount = getTopicsTotalUnreadRaw(state)
  const topicsUnreadBadge = formatNotificationBadgeCount(topicsUnreadCount)
  const supportUnreadBadge = formatNotificationBadgeCount(mailUnreadCount)

  return `
    <style>
      .lobby-nav-btn:not([data-active]):hover {
        border-bottom-color: rgba(212,165,32,0.50) !important;
        color: rgba(255,255,255,0.95) !important;
        background: rgba(212,165,32,0.04) !important;
      }
      .lobby-nav-btn-label {
        position: absolute;
        width: 1px; height: 1px;
        padding: 0; margin: -1px;
        overflow: hidden;
        clip: rect(0,0,0,0);
        white-space: nowrap;
        border: 0;
      }
      .lobby-nav-btn-icon-only {
        position: relative;
        justify-content: center;
        min-width: 62px;
      }
      .lobby-nav-btn-icon-only::after {
        content: attr(data-tooltip);
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%) translateY(6px);
        background: #0a0a0a;
        border: 1px solid rgba(212,165,32,0.35);
        color: #d4a520;
        font-size: 11px; font-weight: 700; letter-spacing: normal; text-transform: none;
        padding: 5px 10px;
        border-radius: 6px;
        white-space: nowrap;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease;
        z-index: 1000;
      }
      .lobby-nav-btn-icon-only:hover::after,
      .lobby-nav-btn-icon-only:focus-visible::after {
        opacity: 1;
      }
    </style>
    <nav style="
      background: #0a0a0a;
      border-bottom: 1px solid rgba(255,255,255,0.10);
      max-width: ${PIKA_DESKTOP_CONTENT_MAX_WIDTH_PX}px;
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

      <div data-lobby-nav-primary-group="1" style="display:flex; align-items:stretch; gap:0; height:100%; flex:1;">
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
        <button type="button" data-lobby-nav-shop="1" ${shopActive ? 'data-active="1"' : ''} class="lobby-nav-btn lobby-nav-btn-icon-only" aria-label="Магазин" data-tooltip="Магазин" style="
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
          <span class="lobby-nav-btn-label">Магазин</span>
        </button>
        ${state.profile.profileId !== null ? `
          <a href="/topics" data-lobby-nav-topics="1" ${topicsActive ? 'data-active="1"' : ''} class="lobby-nav-btn" style="
            position:relative;display:flex; align-items:center; gap:10px;
            padding:0 28px 0 18px;
            background:${topicsActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
            font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
            color:${topicsActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
            border-bottom:2px solid ${topicsActive ? '#d4a520' : 'transparent'};
            text-decoration:none; height:100%;
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            Теми
            ${topicsUnreadBadge !== null ? `<span data-desktop-nav-badge="topics" aria-hidden="true" style="position:absolute;top:6px;right:7px;min-width:18px;height:18px;border-radius:999px;background:#ef4444;color:#fff;border:1.5px solid #0a0a0a;font-size:10px;font-weight:900;line-height:1;display:flex;align-items:center;justify-content:center;padding:0 5px;box-sizing:border-box;">${escapeHtml(topicsUnreadBadge)}</span>` : ''}
          </a>
        ` : ''}
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
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
              ${friendChatUnreadBadge !== null ? `<span data-desktop-nav-badge="chat" style="position:absolute;top:-6px;right:-8px;min-width:16px;height:16px;border-radius:8px;background:#ef4444;color:#fff;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:center;padding:0 3px;line-height:1;">${escapeHtml(friendChatUnreadBadge)}</span>` : ''}
            </span>
            Чат
          </button>
        ` : ''}
        <a href="/tournaments" data-lobby-nav-tournaments="1" ${tournamentsActive ? 'data-active="1"' : ''} class="lobby-nav-btn" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          background:${tournamentsActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:${tournamentsActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
          border-bottom:2px solid ${tournamentsActive ? '#d4a520' : 'transparent'};
          text-decoration:none; height:100%;
        ">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
            <path d="M8 21h8"/>
            <path d="M12 17v4"/>
            <path d="M7 4h10v6a5 5 0 0 1-10 0z"/>
            <path d="M5 4H3v2a4 4 0 0 0 4 4"/>
            <path d="M19 4h2v2a4 4 0 0 1-4 4"/>
          </svg>
          Турнири
        </a>
        <button type="button" data-lobby-nav-friends="1" ${friendsActive ? 'data-active="1"' : ''} class="lobby-nav-btn lobby-nav-btn-icon-only" aria-label="Приятели" data-tooltip="Приятели" style="
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
          <span class="lobby-nav-btn-label">Приятели</span>
          ${incomingFriendRequestsCount > 0 ? `
            <span style="min-width:20px;height:20px;border-radius:999px;background:#d4a520;color:#080808;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;font-size:11px;font-weight:900;line-height:1;">
              ${formatAmount(incomingFriendRequestsCount)}
            </span>
          ` : ''}
        </button>
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
        <a href="/ranking" data-lobby-nav-leaderboards="1" ${leaderboardsActive ? 'data-active="1"' : ''} class="lobby-nav-btn lobby-nav-btn-icon-only" aria-label="Класация" data-tooltip="Класация" style="
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
          <span class="lobby-nav-btn-label">Класация</span>
        </a>
        <button type="button" data-lobby-nav-blocked-players="1" class="lobby-nav-btn lobby-nav-btn-icon-only" aria-label="Блокирани" data-tooltip="Блокирани" style="
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
          <span class="lobby-nav-btn-label">Блокирани</span>
        </button>
      </div>

      <div style="display:flex; align-items:center; gap:4px; margin-left:auto;">
        ${state.profile.profileId !== null ? `
          ${state.isAdminOrSubadmin ? `
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
                ${state.isAdmin ? `
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
                ` : ''}
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
                 display:${supportUnreadBadge !== null ? 'flex' : 'none'}; align-items:center; justify-content:center;
                font-size:10px; font-weight:800; color:#fff;
                padding:0 4px; box-sizing:border-box;
                font-family:Inter,system-ui,sans-serif;
                pointer-events:none;
              ">${supportUnreadBadge !== null ? escapeHtml(supportUnreadBadge) : ''}</span>
            </button>
            ${state.isAdmin || state.isTopicModerator ? `
              <div data-admin-mail-dropdown="1" style="
                display:none;position:absolute;top:100%;right:0;min-width:250px;
                background:#111111;border:1px solid rgba(212,165,32,0.35);
                border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.72);
                z-index:1000;overflow:hidden;
              ">
                ${state.isAdmin ? `
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
                <div style="height:1px;background:rgba(212,165,32,0.18);margin:0 10px;"></div>
                ` : ''}
                ${state.isTopicModerator ? `
                <button type="button" data-lobby-nav-admin-topic-reports="1" style="
                  width:100%;display:flex;align-items:center;justify-content:space-between;gap:14px;
                  border:0;background:none;color:rgba(255,255,255,0.84);padding:13px 14px;
                  cursor:pointer;text-align:left;font-size:13px;font-weight:800;
                " onmouseenter="this.style.background='rgba(212,165,32,0.09)';this.style.color='#d4a520'" onmouseleave="this.style.background='none';this.style.color='rgba(255,255,255,0.84)'">
                  <span>Доклади за теми</span>
                  <span style="min-width:22px;height:22px;border-radius:999px;background:${state.adminTopicReportsPendingCount > 0 ? '#ef4444' : 'rgba(255,255,255,0.10)'};color:#fff;display:inline-flex;align-items:center;justify-content:center;padding:0 7px;font-size:11px;font-weight:900;">${state.adminTopicReportsPendingCount}</span>
                </button>
                ` : ''}
              </div>
            ` : ''}
          </div>
          <button data-lobby-nav-bell="1" style="
            background:none; border:none; cursor:pointer; padding:6px;
            color:rgba(255,255,255,0.65); position:relative;
          ">
            <img src="/assets/lobby/nav-icon-preview/nav-notifications-white.png" alt="" style="width:28px; height:31px; display:block; object-fit:contain;">
            ${notificationsBadge !== null ? `<span style="
              position:absolute; top:2px; right:0px;
              min-width:18px; height:18px; border-radius:9px;
              background:#ef4444; border:1.5px solid #0a0a0a;
              display:flex; align-items:center; justify-content:center;
              font-size:10px; font-weight:800; color:#fff;
              padding:0 4px; box-sizing:border-box;
              font-family:Inter,system-ui,sans-serif;
              pointer-events:none;
            ">${escapeHtml(notificationsBadge)}</span>` : ''}
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

export function resolveLobbyChatSenderRole(
  message: Pick<LobbyChatMessageSnapshot, 'senderIsChatAdmin'> & Partial<Pick<LobbyChatMessageSnapshot, 'senderRole'>>,
): LobbyChatMessageSnapshot['senderRole'] {
  if (
    message.senderRole === 'player' ||
    message.senderRole === 'chat_admin' ||
    message.senderRole === 'pika_team' ||
    message.senderRole === 'top_chat_admin' ||
    message.senderRole === 'subadmin' ||
    message.senderRole === 'admin'
  ) {
    return message.senderRole
  }

  return message.senderIsChatAdmin ? 'chat_admin' : 'player'
}

export function getLobbyChatAuthorNameStyle(
  message: Pick<LobbyChatMessageSnapshot, 'senderIsChatAdmin'> & Partial<Pick<LobbyChatMessageSnapshot, 'senderRole'>>,
): { color: string; extraStyle: string } {
  const senderRole = resolveLobbyChatSenderRole(message)
  const nameColor = senderRole === 'pika_team'
    ? '#c084fc'
    : '#d4a520'
  const nameExtraStyle = senderRole === 'pika_team'
    ? 'text-shadow:0 0 10px rgba(192,132,252,0.42),0 0 18px rgba(192,132,252,0.22);'
    : ''

  return { color: nameColor, extraStyle: nameExtraStyle }
}

export function renderLobbyChatMessageRow(state: LobbyScreenState, message: LobbyChatMessageSnapshot): string {
  const canDelete = state.canDeleteLobbyChat
  const { color: nameColor, extraStyle: nameExtraStyle } = getLobbyChatAuthorNameStyle(message)

  return `
    <div data-lobby-livechat-message="${escapeHtml(message.messageId)}" style="display:flex;align-items:flex-start;gap:5px;font-size:16px;line-height:1.45;word-break:break-word;">
      <div style="flex:1;min-width:0;">
        <span style="color:${nameColor};font-weight:900;${nameExtraStyle}">${escapeHtml(message.senderDisplayName)}:</span>
        <span style="color:#f1f5f9;font-weight:500;"> ${renderLinkifiedChatMessageBody(message.body)}</span>
      </div>
      ${canDelete ? `
        <button type="button" data-lobby-livechat-delete="${escapeHtml(message.messageId)}" aria-label="Изтрий съобщението" title="Изтрий" style="flex:0 0 auto;width:16px;height:16px;line-height:16px;border:0;background:transparent;color:rgba(255,255,255,0.34);font-size:14px;cursor:pointer;padding:0;">×</button>
      ` : ''}
    </div>
  `
}

/**
 * "Публикации от Pika.bg" в лобито — вгражда се вдясно от hero-cards.png в
 * лявото херо каре (desktop/guest) или като компактна лента под профилната
 * карта (mobile). Composer-ът е `readonly` за всеки, който няма право да
 * пише (гост ИЛИ логнат потребител без admin/pika_team роля):
 * - Гост (state.profile.profileId === null): `<form>` носи
 *   data-lobby-livechat-guest-gate — wiring кодът пренасочва клик/submit към
 *   съществуващия auth попъп ('lobby-chat-guest' режим).
 * - Логнат, но без право да пише (!canWriteLobbyChat): `<form>` носи
 *   data-lobby-livechat-write-locked-gate — wiring кодът отваря новия
 *   "Публикации от Pika.bg" popup (lobbyChatWriteLockedPopupOpen), pointerdown/
 *   click pattern mirror на Topics non-VIP composer (renderTopicsScreen.ts) —
 *   виж attachLobbyScreenHandlers.
 */
function renderLobbyChatFullscreenIcon(isFullscreen: boolean): string {
  return isFullscreen
    ? '<path d="M9 3v6H3"/><path d="M15 3v6h6"/><path d="M9 21v-6H3"/><path d="M15 21v-6h6"/>'
    : '<path d="M8 3H3v5"/><path d="M16 3h5v5"/><path d="M8 21H3v-5"/><path d="M16 21h5v-5"/>'
}

function renderLobbyChatPanel(state: LobbyScreenState, opts: { isGuest: boolean; compact: boolean; fullscreen?: boolean }): string {
  const { isGuest, compact } = opts
  const fullscreen = compact && opts.fullscreen === true
  const isDisconnected = !state.isConnected
  const canWrite = !isGuest && state.canWriteLobbyChat
  const isReadOnly = isGuest || !canWrite

  const messagesHtml = state.lobbyChatMessages.length === 0
    ? `<div style="margin:auto;color:rgba(255,255,255,0.42);font-size:12px;font-weight:700;text-align:center;padding:8px;">Все още няма съобщения.</div>`
    : state.lobbyChatMessages.map((m) => renderLobbyChatMessageRow(state, m)).join('')

  const placeholderText = isGuest
    ? 'Влез, за да четеш още...'
    : !canWrite
      ? 'Само екипът на Pika.bg може да пише тук...'
      : isDisconnected
        ? 'Изчакай връзка...'
        : 'Напиши съобщение...'

  const sendButtonDisabled = canWrite && (isDisconnected || state.lobbyChatSending)
  const titleSize = compact ? '11px' : '13px'
  const rowHeight = compact ? '30px' : '34px'
  const fontSize = compact ? '13px' : '13px'
  const fullscreenToggle = compact
    ? `
        <button
          type="button"
          data-lobby-livechat-fullscreen-toggle="1"
          aria-label="${fullscreen ? 'Свий панела' : 'Разгъни панела на цял екран'}"
          title="${fullscreen ? 'Свий' : 'Цял екран'}"
          style="width:26px;height:26px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(212,165,32,0.62);border-radius:6px;background:#050505;color:#d4a520;padding:0;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(212,165,32,0.12);flex:0 0 auto;"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#d4a520" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;">${renderLobbyChatFullscreenIcon(fullscreen)}</svg>
        </button>
      `
    : ''

  const gateAttribute = isGuest
    ? 'data-lobby-livechat-guest-gate="1"'
    : !canWrite
      ? 'data-lobby-livechat-write-locked-gate="1"'
      : ''

  return `
    <div style="display:flex;flex-direction:column;min-width:0;height:100%;box-sizing:border-box;">
      ${compact ? `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0;padding-bottom:${fullscreen ? '5' : '2'}px;border-bottom:1px solid rgba(212,165,32,0.28);">
          <div style="font-size:${titleSize};font-weight:900;letter-spacing:0.06em;text-transform:uppercase;color:#d4a520;">Публикации от Pika.BG</div>
          <div style="display:flex;align-items:center;gap:8px;flex:0 0 auto;">
            ${isDisconnected ? `<div style="font-size:10px;font-weight:800;color:#f87171;">Няма връзка</div>` : ''}
            ${fullscreenToggle}
          </div>
        </div>
      ` : `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-shrink:0;padding-bottom:7px;">
          <div style="font-size:${titleSize};font-weight:900;letter-spacing:0.06em;text-transform:uppercase;color:#d4a520;">Публикации от Pika.BG</div>
          ${isDisconnected ? `<div style="font-size:10px;font-weight:800;color:#f87171;">Няма връзка</div>` : ''}
        </div>
      `}
      <div data-lobby-livechat-messages-scroll="1" style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:5px;padding-right:4px;scrollbar-width:thin;scrollbar-color:#d4a520 #111111;">
        ${messagesHtml}
      </div>
      ${state.lobbyChatErrorText ? `
        <div style="flex-shrink:0;margin-top:4px;font-size:11px;font-weight:800;color:#fecaca;">${escapeHtml(state.lobbyChatErrorText)}</div>
      ` : ''}
      <form data-lobby-livechat-form="1" ${gateAttribute} style="display:flex;gap:6px;margin-top:6px;flex-shrink:0;">
        <input
          type="text"
          name="lobbyChatMessage"
          data-lobby-livechat-input="1"
          value="${escapeHtml(state.lobbyChatDraft)}"
          maxlength="600"
          autocomplete="off"
          ${isReadOnly ? 'readonly' : ''}
          placeholder="${escapeHtml(placeholderText)}"
          style="flex:1;min-width:0;height:${rowHeight};border-radius:7px;border:1px solid rgba(212,165,32,0.30);background:#050505;color:#ffffff;padding:0 10px;font-size:${fontSize};font-weight:600;outline:none;box-sizing:border-box;${isReadOnly ? 'cursor:pointer;' : ''}"
        >
        <button
          type="submit"
          data-lobby-livechat-send="1"
          ${sendButtonDisabled ? 'disabled' : ''}
          style="flex:0 0 auto;height:${rowHeight};padding:0 14px;border:0;border-radius:7px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;opacity:${sendButtonDisabled ? '0.55' : '1'};"
        >&#10148;</button>
      </form>
    </div>
  `
}

/**
 * Дясната замяна на старото heroBannerHtml (hero-banner.png) — вляво
 * hero-cards.png (обект без деформация/изрязване), вдясно лайв чат. Обща
 * височина на кутията остава 254px (както преди), само вътрешната подредба
 * се променя.
 */
function renderLobbyHeroCardsAndChat(state: LobbyScreenState, isGuest: boolean): string {
  return `
    <div style="flex:0 1 985px; min-width:0; border:2px solid rgba(212,165,32,0.88); border-radius:14px; box-sizing:border-box; background: linear-gradient(160deg, #050505 0%, #0d0d0d 100%); height:258px; padding:14px; display:flex; align-items:stretch; gap:14px; overflow:hidden;">
      <div style="flex:0 0 auto; height:100%; display:flex; align-items:center; justify-content:center;">
        <img src="/assets/lobby/hero-cards.png" alt="Белот карти" style="height:100%; width:auto; max-width:420px; display:block; object-fit:contain;">
      </div>
      <div style="width:1px; align-self:stretch; background:rgba(212,165,32,0.30); flex-shrink:0;"></div>
      <div style="flex:1; min-width:0; height:100%;">
        ${renderLobbyChatPanel(state, { isGuest, compact: false })}
      </div>
    </div>
  `
}

function renderGuestHeroCard(state: LobbyScreenState, signupBonus: number, useMobileLayout = false): string {
  const bonusText = formatAmount(signupBonus)
  const heroBannerHtml = useMobileLayout
    ? ''
    : renderLobbyHeroCardsAndChat(state, true)
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
  state: LobbyScreenState,
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
    : renderLobbyHeroCardsAndChat(state, false)
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

export function normalizeNotificationBadgeCount(count: number): number {
  if (!Number.isFinite(count)) return 0
  return Math.max(0, Math.floor(count))
}

export function formatNotificationBadgeCount(count: number): string | null {
  const normalized = normalizeNotificationBadgeCount(count)
  if (normalized <= 0) return null
  return normalized >= 100 ? '99+' : String(normalized)
}

function sumConversationUnreadByKind(state: LobbyScreenState, kind: ChatConversationSnapshot['kind']): number {
  return state.chatConversations
    .filter((conversation) => conversation.kind === kind)
    .reduce((total, conversation) => total + normalizeNotificationBadgeCount(conversation.unreadCount), 0)
}

export function getFriendChatUnreadRaw(state: LobbyScreenState): number {
  return sumConversationUnreadByKind(state, 'friend')
}

export function getTopicsPersonalUnreadRaw(state: LobbyScreenState): number {
  return sumConversationUnreadByKind(state, 'vip_dm')
}

export function getTopicsMessagesUnreadRaw(state: LobbyScreenState): number {
  const generalTopic = (state.topics ?? []).find((topic) =>
    topic.isGeneral || topic.topicId === 'topic-general' || topic.slug === 'general',
  )
  return normalizeNotificationBadgeCount(generalTopic?.unreadCount ?? 0)
}

/**
 * "Лафче" принос към агрегирания Topics badge — ВИНАГИ 0 или 1, никога
 * реалният брой непрочетени постове (Лафче брифа §9: "1 или 100 нови
 * поста = пак една червена точка"). generalTopic-a по-горе НИКОГА не
 * включва lafche (търси само isGeneral/topic-general/slug==='general'),
 * значи няма double-count риск тук — просто добавяме тази стойност отделно.
 */
export function getLafcheUnreadContribution(state: LobbyScreenState): number {
  const lafcheTopic = (state.topics ?? []).find((topic) => topic.topicId === LAFCHE_TOPIC_ID)
  return (lafcheTopic?.unreadCount ?? 0) > 0 ? 1 : 0
}

export function getTopicsTotalUnreadRaw(state: LobbyScreenState): number {
  return getTopicsMessagesUnreadRaw(state) + getTopicsPersonalUnreadRaw(state) + getLafcheUnreadContribution(state)
}

export function getSupportUnreadRaw(state: LobbyScreenState): number {
  return normalizeNotificationBadgeCount(state.supportUnreadCount) +
    (state.isAdmin ? normalizeNotificationBadgeCount(state.adminGuestContactUnreadCount) : 0)
}

export function getFriendsNotificationRaw(state: LobbyScreenState): number {
  return getPendingFriendRequestBadgeCount(state)
}

export function getMobileMenuNotificationRaw(state: LobbyScreenState): number {
  return getFriendChatUnreadRaw(state) +
    getTopicsTotalUnreadRaw(state) +
    getSupportUnreadRaw(state) +
    getFriendsNotificationRaw(state)
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
      <label style="
        display:flex;align-items:center;gap:10px;
        padding:12px 16px;
        border-bottom:1px solid rgba(255,255,255,0.06);
        cursor:pointer;
        user-select:none;
      ">
        <input
          type="checkbox"
          data-private-room-in-game-notifications-toggle="1"
          ${state.privateRoomInGameNotificationsEnabled ? 'checked' : ''}
          style="width:17px;height:17px;accent-color:#d4a520;cursor:pointer;flex-shrink:0;"
        >
        <span style="display:flex;flex-direction:column;gap:2px;min-width:0;">
          <span style="font-size:13px;font-weight:800;color:#f8fafc;">Известия за частни маси по време на игра</span>
          <span style="font-size:11px;line-height:1.35;color:rgba(255,255,255,0.48);">Когато е изключено, извън игра известията остават активни.</span>
        </span>
      </label>
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
    onPrivateRoomInGameNotificationsChange: (enabled: boolean) => void
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
    .querySelector<HTMLInputElement>('[data-private-room-in-game-notifications-toggle="1"]')
    ?.addEventListener('change', (event) => {
      callbacks.onPrivateRoomInGameNotificationsChange((event.currentTarget as HTMLInputElement).checked)
    })

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

export function renderBottomSection(
  lobbyPackages: CoinPackageSnapshot[],
  isLoggedIn: boolean,
  unclaimedMissionsCount: number,
  hasUnclaimedDailyReward = false,
  useMobileLayout = false,
  privateRoomsCount = 0,
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
      position:relative;
      ${isFirstPkg ? 'z-index:2;' : ''}
    ">
      ${pkg.isTopOffer ? renderTopOfferBadge() : ''}
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
        position:relative;
        min-height:137px;
        transition:border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
      "
      onmouseenter="this.style.borderColor='rgba(167,139,250,0.96)';this.style.boxShadow='inset 0 0 0 1px rgba(167,139,250,0.96)';this.style.background='rgba(167,139,250,0.05)'"
      onmouseleave="this.style.borderColor='rgba(167,139,250,0.78)';this.style.boxShadow='none';this.style.background='#000000'"
      >
        ${renderQuickActionBadge(privateRoomsCount)}
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

export function getPrivateRoomsBadgeCount(privateRooms: readonly PrivateRoomSnapshot[]): number {
  return privateRooms.length
}

function renderQuickActionBadge(count: number): string {
  const displayCount = formatNotificationBadgeCount(count)
  if (displayCount === null) {
    return ''
  }

  return `<span aria-hidden="true" style="position:absolute;top:10px;right:12px;min-width:20px;height:20px;border-radius:999px;background:#ef4444;color:#ffffff;border:2px solid #000000;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;line-height:1;box-shadow:0 0 0 2px rgba(239,68,68,0.22),0 0 14px rgba(239,68,68,0.72);padding:0 5px;box-sizing:border-box;">${escapeHtml(displayCount)}</span>`
}

function renderMobileMenu(state: LobbyScreenState): string {
  const pendingCount = getNotificationsBadgeCount(state)
  const pendingBadge = formatNotificationBadgeCount(pendingCount)
  const friendChatUnreadCount = getFriendChatUnreadRaw(state)
  const topicsUnreadCount = getTopicsTotalUnreadRaw(state)
  const supportUnreadCount = getSupportUnreadRaw(state)
  const friendsNotificationCount = getFriendsNotificationRaw(state)
  const mobileMenuBadgeCount = getMobileMenuNotificationRaw(state)
  const mobileMenuBadge = formatNotificationBadgeCount(mobileMenuBadgeCount)

  // Consume-ва one-shot flag-а ТУК (виж декларацията му по-горе) — играе
  // entrance анимацията само за mount-а веднага след реално closed->open
  // (openMobileMenu()); всеки следващ mount, докато менюто остава логически
  // отворено (background render/innerHTML remount), вижда pending=false и
  // рендира panel/backdrop БЕЗ animation декларация → без replay/flicker.
  const shouldPlayMobileMenuEntranceAnimation = mobileMenuOpen && mobileMenuEntranceAnimationPending
  if (shouldPlayMobileMenuEntranceAnimation) {
    mobileMenuEntranceAnimationPending = false
  }
  const mobileMenuBackdropAnimationStyle = shouldPlayMobileMenuEntranceAnimation
    ? 'animation:mobile-menu-backdrop-in 120ms ease both;'
    : ''
  const mobileMenuPanelAnimationStyle = shouldPlayMobileMenuEntranceAnimation
    ? 'animation:mobile-menu-shade-in 150ms cubic-bezier(0.2,0.8,0.2,1) both;'
    : ''

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
            ${pendingBadge !== null ? `<span style="position:absolute;right:4px;top:4px;min-width:16px;height:16px;border-radius:8px;background:#ef4444;color:#fff;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:center;padding:0 3px;">${escapeHtml(pendingBadge)}</span>` : ''}
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
            <span data-mobile-menu-total-badge="1" style="position:absolute;right:-6px;top:-6px;min-width:18px;height:18px;border-radius:999px;background:#ef4444;color:#fff;border:2px solid #050505;font-size:10px;font-weight:900;line-height:1;display:${mobileMenuBadge !== null ? 'flex' : 'none'};align-items:center;justify-content:center;padding:0 5px;box-sizing:border-box;">${mobileMenuBadge !== null ? escapeHtml(mobileMenuBadge) : ''}</span>
          </summary>
          <button type="button" data-lobby-mobile-menu-backdrop="1" aria-label="Затвори менюто" style="
            position:fixed;inset:0;z-index:1;border:0;background:rgba(0,0,0,0.01);
            padding:0;margin:0;cursor:default;${mobileMenuBackdropAnimationStyle}
          "></button>
          <div data-lobby-mobile-menu-panel="1" style="
            position:absolute;right:0;top:50px;width:min(82vw,280px);
            background:#090909;border:1px solid rgba(212,165,32,0.38);border-radius:8px;
            box-shadow:0 18px 44px rgba(0,0,0,0.68);padding:8px;display:grid;gap:6px;
            z-index:2;transform-origin:top right;${mobileMenuPanelAnimationStyle}
          ">
            <button type="button" data-lobby-nav-lobby="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('lobby', 'Лоби')}</button>
            <button type="button" data-lobby-nav-shop="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('shop', 'Магазин')}</button>
            ${state.profile.profileId !== null ? `
              <button type="button" data-lobby-nav-topics="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('topics', 'Теми', topicsUnreadCount)}</button>
              <button type="button" data-lobby-nav-chat="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('chat', 'Чат', friendChatUnreadCount)}</button>
            ` : ''}
            <button type="button" data-lobby-nav-tournaments="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('tournaments', 'Турнири')}</button>
            ${state.profile.profileId !== null ? `
              <button type="button" data-lobby-nav-friends="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('friends', 'Приятели', friendsNotificationCount)}</button>
            ` : ''}
            <button type="button" data-lobby-nav-players="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('players', 'Играчите')}</button>
            <button type="button" data-lobby-nav-leaderboards="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('leaderboards', 'Класация')}</button>
            ${state.profile.profileId !== null ? `
              <button type="button" data-lobby-nav-blocked-players="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('blocked', 'Блокирани')}</button>
              <button type="button" data-lobby-nav-support="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('support', 'Поддръжка', supportUnreadCount)}</button>
              ${state.isAdminOrSubadmin ? `
                ${state.isAdmin ? `
                <button type="button" data-lobby-nav-admin="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('admin', 'Админ настройки')}</button>
                ` : ''}
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
  icon: 'admin' | 'blocked' | 'chat' | 'friends' | 'leaderboards' | 'lobby' | 'login' | 'logout' | 'players' | 'shop' | 'support' | 'tournaments' | 'topics',
  label: string,
  badgeCount = 0,
): string {
  const stroke = icon === 'logout' ? '#fecaca' : '#d4a520'
  const badge = formatNotificationBadgeCount(badgeCount)
  const path = icon === 'support'
    ? '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'
    : icon === 'admin'
      ? '<path d="M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7l7-4z"/><path d="M9 12l2 2 4-4"/>'
      : icon === 'tournaments'
        ? '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v6a5 5 0 0 1-10 0z"/><path d="M5 4H3v2a4 4 0 0 0 4 4"/><path d="M19 4h2v2a4 4 0 0 1-4 4"/>'
      : icon === 'blocked'
        ? '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'
      : icon === 'topics'
        ? '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'
      : icon === 'chat'
        ? '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'
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
    <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(label)}</span>
    <span data-mobile-menu-item-badge="${icon}" aria-hidden="true" style="margin-left:auto;min-width:22px;height:20px;border-radius:999px;background:#ef4444;color:#fff;border:1px solid rgba(5,5,5,0.96);font-size:11px;font-weight:900;line-height:1;display:inline-flex;visibility:${badge !== null ? 'visible' : 'hidden'};align-items:center;justify-content:center;padding:0 6px;box-sizing:border-box;flex:0 0 auto;">${badge !== null ? escapeHtml(badge) : ''}</span>
  `
}

/**
 * Компактна лента с лайв чат за телефон — постоянна (не collapsed) фиксирана
 * височина ~156px, между профилната карта и "Избери маса". Собствен вертикален
 * scroll в зоната със съобщения; цялата лента не расте извън border-а.
 */
function renderMobileLobbyChatSection(state: LobbyScreenState): string {
  const isGuest = state.profile.profileId === null
  const isFullscreen = state.lobbyChatFullscreen
  const sectionStyle = isFullscreen
    ? 'position:fixed;inset:0;z-index:16000;background:#080808;border:2px solid rgba(212,165,32,0.90);border-radius:0;padding:calc(10px + env(safe-area-inset-top,0px)) calc(10px + env(safe-area-inset-right,0px)) calc(10px + env(safe-area-inset-bottom,0px)) calc(10px + env(safe-area-inset-left,0px));height:100vh;height:100dvh;box-sizing:border-box;'
    : 'margin:0 12px 12px;border:2px solid rgba(212,165,32,0.84);border-radius:8px;background:#080808;padding:2px 2px 6px 6px;height:190px;box-sizing:border-box;'

  return `
    <section data-lobby-livechat-mobile-section="1" ${isFullscreen ? 'data-lobby-livechat-fullscreen="1"' : ''} style="${sectionStyle}">
      ${renderLobbyChatPanel(state, { isGuest, compact: true, fullscreen: isFullscreen })}
    </section>
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

export function renderMobileOffersSection(lobbyPackages: CoinPackageSnapshot[], isLoggedIn: boolean): string {
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
        position:relative;
        flex:0 0 calc(100vw - 128px);max-width:none;min-height:136px;border-radius:8px;
        border:2px solid rgba(212,165,32,0.84);background:#080808;padding:12px;
        display:grid;grid-template-columns:82px minmax(0,1fr);gap:10px;align-items:center;scroll-snap-align:${snapAlign};${snapMargin}box-sizing:border-box;
      ">
        ${pkg.isTopOffer ? renderTopOfferBadge() : ''}
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
      <div style="display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;padding:14px 12px 8px;scroll-padding-left:12px;scroll-padding-right:12px;-webkit-overflow-scrolling:touch;">
        ${cards}
      </div>
    </section>
  `
}

function renderMobileQuickActions(unclaimedMissionsCount: number, hasUnclaimedDailyReward: boolean, privateRoomsCount: number): string {
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
        ${renderQuickActionBadge(privateRoomsCount)}
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

export function renderMobilePlayerListCard(player: PlayerPublicProfileSnapshot, attrName: string, showOnlineStatus: boolean): string {
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
      ${showOnlineStatus && player.isOnline !== undefined ? `<div style="color:${player.isOnline ? '#4ade80' : '#f87171'};font-size:11px;font-weight:900;flex:0 0 auto;">${player.isOnline ? 'Онлайн' : 'Офлайн'}</div>` : ''}
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
): {
  allPlayers: PlayerPublicProfileSnapshot[]
  players: PlayerPublicProfileSnapshot[]
  isSearchActive: boolean
} {
  const allPlayers = orderPlayersForViewer(state.players, opts)
  const query = state.playersSearchQuery.trim()
  const isSearchActive = query !== ''

  if (isSearchActive && state.playersSearchResults !== null) {
    return {
      allPlayers,
      players: orderPlayersForViewer(state.playersSearchResults, opts),
      isSearchActive,
    }
  }

  const normalizedQuery = query.toLocaleLowerCase()
  const players = query
    ? allPlayers.filter((p) => (p.displayName ?? '').toLocaleLowerCase().includes(normalizedQuery))
    : allPlayers

  return { allPlayers, players, isSearchActive }
}

/**
 * Pagination navigация `< 1 2 3 4 … >` — рендира се еднакво над и под
 * grid-а (desktop и mobile), скрита докато search резултати са активни.
 */
function renderPlayersPager(state: LobbyScreenState): string {
  const totalPages = state.playersTotalPages
  if (totalPages <= 1) return ''

  const currentPage = state.playersPage
  const items = computePaginationItems(currentPage, totalPages)
  const isFirst = currentPage <= 1
  const isLast = currentPage >= totalPages

  const arrowStyle = (disabled: boolean): string =>
    `min-width:34px;height:34px;padding:0 10px;border-radius:6px;border:1px solid rgba(212,165,32,0.4);background:${disabled ? 'rgba(255,255,255,0.04)' : '#0d0d0d'};color:${disabled ? 'rgba(255,255,255,0.28)' : '#d4a520'};font-size:15px;font-weight:900;cursor:${disabled ? 'default' : 'pointer'};`

  return `
    <nav data-lobby-players-pager="1" aria-label="Странициране на играчите" style="display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;padding:2px 0;">
      <button type="button" data-lobby-players-page="prev" ${isFirst ? 'disabled' : ''} aria-label="Предишна страница" style="${arrowStyle(isFirst)}">‹</button>
      ${items.map((item) => item === 'ellipsis'
        ? `<span aria-hidden="true" style="min-width:24px;height:34px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.4);font-weight:900;">…</span>`
        : `<button type="button" data-lobby-players-page="${item}" ${item === currentPage ? 'aria-current="page"' : ''} style="min-width:34px;height:34px;padding:0 8px;border-radius:6px;border:1px solid ${item === currentPage ? '#d4a520' : 'rgba(212,165,32,0.28)'};background:${item === currentPage ? '#d4a520' : '#0d0d0d'};color:${item === currentPage ? '#080808' : '#f8fafc'};font-size:14px;font-weight:900;cursor:pointer;">${item}</button>`
      ).join('')}
      <button type="button" data-lobby-players-page="next" ${isLast ? 'disabled' : ''} aria-label="Следваща страница" style="${arrowStyle(isLast)}">›</button>
    </nav>
  `
}

function renderMobilePlayersDirectory(state: LobbyScreenState): string {
  if (state.playersLoading) return `${renderMobilePageTitle('Играчите')}${renderMobileStateMessage('Зареждане на играчи...')}`
  if (state.playersErrorText) return `${renderMobilePageTitle('Играчите')}${renderMobileStateMessage(state.playersErrorText, 'error')}`

  const { players, isSearchActive } = computePlayersDirectoryLists(state, {
    isAdmin: state.isAdminOrSubadmin,
    ownProfileId: state.profile.profileId,
  })
  const applied = state.playersSearchQuery.trim()

  return `
    ${renderMobilePageTitle('Играчите', `${formatAmount(state.playersTotalCount)} профила`)}
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
    ${!isSearchActive ? `<div style="padding:0 12px;">${renderPlayersPager(state)}</div>` : ''}
    <section style="padding:4px 12px 12px;display:grid;gap:9px;">
      ${state.playersTotalCount === 0
        ? renderMobileStateMessage('Все още няма регистрирани играчи.')
        : players.length === 0 && applied !== ''
          ? renderMobileStateMessage('Няма намерени играчи.')
          : players.map((player) => renderMobilePlayerListCard(player, 'data-lobby-player-card', state.isAdminOrSubadmin)).join('')}
    </section>
    ${!isSearchActive ? `<div style="padding:0 12px 16px;">${renderPlayersPager(state)}</div>` : ''}
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

export function renderMobileShopPanel(state: LobbyScreenState): string {
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
          <article style="position:relative;border:1px solid rgba(212,165,32,0.46);border-radius:8px;background:#080808;padding:12px;display:grid;grid-template-columns:84px minmax(0,1fr);gap:10px;align-items:center;${coinPackage.isTopOffer ? 'margin-top:14px;' : ''}">
            ${coinPackage.isTopOffer ? renderTopOfferBadge() : ''}
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
          ${variant === 'friend' ? renderFriendOnlineStatusDot(relationship.isOnline) : ''}
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

  // Виж коментара при renderChatPanel's visibleConversations — идентичен
  // filter fix (mobile огледало на същия панел, същият production bug).
  const sortedConversations = state.chatConversations
    .filter((conversation) => conversation.kind === 'friend' || conversation.kind === 'pika_support')
    .sort(
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
          const unreadBadge = formatNotificationBadgeCount(conversation.unreadCount)
          return `<button type="button" data-lobby-chat-conversation="${escapeHtml(conversation.friendshipId)}" style="flex:0 0 88px;border:1px solid ${isActive ? 'rgba(212,165,32,0.72)' : 'rgba(255,255,255,0.12)'};border-radius:8px;background:#080808;color:#ffffff;padding:8px;display:grid;gap:6px;justify-items:center;"><div style="position:relative;width:44px;height:44px;flex:0 0 auto;"><div style="width:100%;height:100%;border-radius:8px;background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-weight:900;">${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : escapeHtml(displayName.charAt(0).toUpperCase() || '?')}</div>${renderFriendOnlineStatusDot(conversation.friend.isOnline)}</div><div style="max-width:72px;font-size:11px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayName)}</div>${unreadBadge !== null ? `<div style="font-size:10px;font-weight:900;color:#fca5a5;">${escapeHtml(unreadBadge)} нови</div>` : ''}</button>`
        }).join('')}
      </div>

      <div style="border:1px solid rgba(212,165,32,0.28);border-radius:8px;background:#080808;overflow:hidden;">
        ${activeConversation === null ? `<div style="min-height:240px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.58);font-size:14px;font-weight:800;text-align:center;padding:18px;">Избери приятел от списъка.</div>` : `
          <div style="padding:10px 12px;border-bottom:1px solid rgba(212,165,32,0.20);font-size:15px;font-weight:900;color:#ffffff;">${escapeHtml(activeConversation.friend.displayName ?? 'Играч')}</div>
          <div data-chat-messages-scroll="1" style="height:360px;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:6px;">
            ${state.chatMessagesLoading ? `<div style="margin:auto;color:#d4a520;font-size:14px;font-weight:900;">Зареждане...</div>` : state.chatMessages.length === 0 ? `<div style="margin:auto;color:rgba(255,255,255,0.58);font-size:14px;font-weight:800;text-align:center;">Няма съобщения.</div>` : state.chatMessages.map((message) => {
              const hasText = message.body.trim().length > 0
              return `<div style="align-self:${message.isOwnMessage ? 'flex-end' : 'flex-start'};max-width:82%;">${message.attachment ? `
                <div style="border-radius:8px;background:${message.isOwnMessage ? 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)' : 'rgba(255,255,255,0.08)'};color:${message.isOwnMessage ? '#080808' : '#f8fafc'};padding:6px;display:grid;gap:6px;">
                  ${renderChatAttachmentBubble(message.attachment, state.apiBaseUrl)}
                  ${hasText ? `<div style="padding:0 4px 2px;font-size:13px;font-weight:800;line-height:1.35;word-break:break-word;">${renderPersonalChatMessageBody(message.body)}</div>` : ''}
                </div>
              ` : `
                <div style="border-radius:8px;background:${message.isOwnMessage ? 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)' : 'rgba(255,255,255,0.08)'};color:${message.isOwnMessage ? '#080808' : '#f8fafc'};padding:7px 9px;font-size:13px;font-weight:800;line-height:1.35;word-break:break-word;">${renderPersonalChatMessageBody(message.body)}</div>
              `}<div style="margin-top:2px;font-size:10px;font-weight:800;color:rgba(255,255,255,0.38);text-align:${message.isOwnMessage ? 'right' : 'left'};">${escapeHtml(formatChatTime(message.createdAt))}</div></div>`
            }).join('')}
          </div>
          <form data-lobby-chat-form="${escapeHtml(activeConversation.friendshipId)}" style="display:flex;flex-direction:column;gap:6px;padding:10px;border-top:1px solid rgba(212,165,32,0.20);">
            <div style="display:flex;gap:8px;align-items:center;">
              ${renderChatImagePickerControls(state, activeConversation.friendshipId)}
              <input name="message" data-lobby-chat-message-input="1" value="${escapeHtml(state.chatDraftByFriendshipId[activeConversation.friendshipId] ?? '')}" maxlength="1000" autocomplete="off" placeholder="Съобщение..." ${state.chatUploadingFriendshipIds.has(activeConversation.friendshipId) ? 'disabled' : ''} style="height:40px;flex:1;min-width:0;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 10px;font-size:14px;font-weight:700;outline:none;">
              <button type="submit" ${state.chatUploadingFriendshipIds.has(activeConversation.friendshipId) ? 'disabled' : ''} style="height:40px;padding:0 12px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;opacity:${state.chatUploadingFriendshipIds.has(activeConversation.friendshipId) ? '0.6' : '1'};">${state.chatUploadingFriendshipIds.has(activeConversation.friendshipId) ? 'Качване…' : 'Изпрати'}</button>
            </div>
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
    // Topics view се нуждае от <main>, участващ в flex height chain-a
    // (flex:1;min-height:0), за да може renderTopicsScreen да получи
    // изчислима height отдолу нагоре — вместо обичайния "padding + normal
    // block flow", който разчита на родителския page-level overflow-y:auto
    // (изрично изключен за Topics, виж root wrapper-а по-горе).
    const mainStyle = state.view === 'topics'
      ? 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;'
      : 'padding:12px;'
    return `
      <main style="${mainStyle}">
        ${state.view === 'support'
          ? renderAdminSupportPage(state, true)
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
                  isAdmin: state.isAdminOrSubadmin,
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
                  isAdmin: state.isAdminOrSubadmin,
                  loading: state.adminPaymentDetailLoading,
                  errorText: state.adminPaymentDetailErrorText,
                  purchase: state.adminPaymentDetailPurchase,
                },
                { onBack: () => {} },
              )
          : state.view === 'admin-tournaments'
            ? renderAdminTournamentsPanel({
                isAdminOrSubadmin: state.isAdminOrSubadmin,
                canWrite: state.adminTournamentsCanWrite,
                loading: state.adminTournamentsLoading,
                errorText: state.adminTournamentsErrorText,
                rows: state.adminTournamentsRows,
                total: state.adminTournamentsTotal,
                filters: state.adminTournamentsFilters,
              })
          : state.view === 'admin-tournament-detail'
            ? renderAdminTournamentDetailPanel({
                isAdminOrSubadmin: state.isAdminOrSubadmin,
                canWrite: state.adminTournamentsCanWrite,
                loading: state.adminTournamentDetailLoading,
                errorText: state.adminTournamentDetailErrorText,
                tournament: state.adminTournamentDetail,
                actionBusy: state.adminTournamentActionBusy,
                actionErrorText: state.adminTournamentActionErrorText,
                actionInfoText: state.adminTournamentActionInfoText,
                cancelConfirmOpen: state.adminTournamentCancelConfirmOpen,
              })
          : state.view === 'tournaments'
            ? renderTournamentsScreen(state)
          : state.view === 'tournament-detail'
            ? renderTournamentDetailScreen(state)
          : state.view === 'tournament-how-it-works'
            ? renderTournamentHowItWorksPage(true)
          : state.view === 'topics'
            ? renderTopicsScreen(state)
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
      ${renderMobileLobbyChatSection(state)}
      ${renderMobileStakeSection(state.selectedStake, canStartSearch, state.isSearching, state.matchRooms, state.profile.level ?? 1, state.matchRoomsLoading, state.profile.profileId === null)}
      ${renderMobileOffersSection(state.lobbyPackages, state.profile.profileId !== null)}
      ${renderMobileQuickActions(state.dailyMissionsUnclaimedCount, getUnclaimedDailyRewardsBadgeCount(state) > 0, getPrivateRoomsBadgeCount(state.privateRooms))}
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
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-footer-legal-link="1" data-consent-open-settings="1" href="#" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Настройки на бисквитките</a>
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
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-mobile-footer-legal-link="1" data-consent-open-settings="1" href="#" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Настройки на бисквитките</a>
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

function renderFriendOnlineStatusDot(isOnline: boolean | undefined): string {
  if (isOnline === undefined) return ''

  const statusClass = isOnline ? 'friend-online-status-dot--online' : 'friend-online-status-dot--offline'
  const statusLabel = isOnline ? 'Онлайн' : 'Офлайн'
  const statusColor = isOnline ? '#22c55e' : '#ef4444'

  return `<span class="friend-online-status-dot ${statusClass}" aria-label="${statusLabel}" title="${statusLabel}" style="position:absolute;right:-2px;bottom:-2px;width:11px;height:11px;border-radius:50%;background:${statusColor};border:2px solid #050505;box-sizing:border-box;pointer-events:none;"></span>`
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
          ${variant === 'friend' ? renderFriendOnlineStatusDot(relationship.isOnline) : ''}
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

// Image bubble за chat съобщение с прикачена снимка — width/height атрибути
// идват директно от DB метаданните (записани при upload, виж
// createChatAttachmentWebp в index.ts), за да няма layout shift докато
// снимката се зарежда. Всички динамични стойности минават през escapeHtml
// (никакво innerHTML с непроверени attachment полета).
export type RenderableImageAttachment = {
  width: number
  height: number
  viewUrl: string
  downloadUrl: string
}

// Protected attachment view/download URL-ите, връщани от сървъра
// (chatStore/supportStore/topicMessageStore buildAttachmentUrls), винаги са
// relative пътища (/api/.../attachments/...) — коректно за same-origin
// production, но в local dev frontend-ът тича на отделен Vite origin
// (:5173), докато бекендът е на :3001 (виж vite.config.ts — proxy-нат е
// само /uploads, НЕ /api). Relative src/href в browser-а resolve-ва спрямо
// document origin-а (:5173), удря SPA fallback-а и връща index.html вместо
// снимката (Content-Type: text/html). Reuse на established resolver-а
// (main.ts getApiBaseUrl — СЪЩИЯТ helper, ползван от ВСЕКИ fetch() в
// приложението): localhost/127.0.0.1 → изричен :3001 origin; иначе празен
// string (production same-origin/proxy, url-ът остава relative непроменен).
export function resolveAttachmentUrl(apiBaseUrl: string, path: string): string {
  return `${apiBaseUrl}${path}`
}

// Click отваря reusable in-app image viewer (renderImageViewerOverlay по-долу)
// ВМЕСТО target="_blank" — старият new-tab подход бе проблемен за PWA Back
// button (виж т.11/12 от Attachment брифа: потребителят не можеше нормално
// да затвори new tab-а и стигаше до затваряне на цялото приложение).
export function renderChatAttachmentBubble(attachment: RenderableImageAttachment, apiBaseUrl: string): string {
  const viewUrl = resolveAttachmentUrl(apiBaseUrl, attachment.viewUrl)
  const downloadUrl = resolveAttachmentUrl(apiBaseUrl, attachment.downloadUrl)
  return `
    <div style="display:grid;gap:6px;max-width:calc(100% - 12px);">
      <button
        type="button"
        data-image-viewer-open="1"
        data-image-viewer-view-url="${escapeHtml(viewUrl)}"
        data-image-viewer-download-url="${escapeHtml(downloadUrl)}"
        style="display:block;border-radius:8px;overflow:hidden;line-height:0;border:0;padding:0;background:transparent;cursor:pointer;text-align:left;width:100%;"
      >
        <img
          src="${escapeHtml(viewUrl)}"
          width="${attachment.width}"
          height="${attachment.height}"
          loading="lazy"
          alt=""
          style="display:block;max-width:100%;width:100%;height:auto;border-radius:8px;background:rgba(255,255,255,0.06);pointer-events:none;"
        >
      </button>
      <a href="${escapeHtml(downloadUrl)}" download style="display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:900;color:inherit;text-decoration:none;opacity:0.82;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>
        Изтегли файл
      </a>
    </div>
  `
}

// Reusable fullscreen in-app image viewer (lightbox) — заменя target="_blank"
// навсякъде в приложението (chat + Topics, виж т.11/13 от Attachment брифа).
// Feature-agnostic: не знае нищо за chat/Topics, работи само с viewUrl/
// downloadUrl. History integration (X/Esc/backdrop → history.back(),
// system Back → popstate consume) е в createLobbyFlowController.ts
// (openImageViewer/closeImageViewer/handleWindowPopstate).
function renderImageViewerOverlay(state: LobbyScreenState): string {
  const viewer = state.imageViewer
  if (!viewer) return ''

  return `
    <div
      data-image-viewer-backdrop="1"
      style="
        position:fixed;inset:0;z-index:9800;
        background:rgba(0,0,0,0.92);
        display:flex;align-items:center;justify-content:center;
        padding:env(safe-area-inset-top,0) env(safe-area-inset-right,0) env(safe-area-inset-bottom,0) env(safe-area-inset-left,0);
      "
    >
      <button
        type="button"
        data-image-viewer-close="1"
        title="Затвори"
        aria-label="Затвори"
        style="
          position:fixed;top:calc(12px + env(safe-area-inset-top,0));right:calc(12px + env(safe-area-inset-right,0));z-index:9820;
          width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,0.24);
          background:rgba(10,10,10,0.72);color:#f8fafc;font-size:22px;font-weight:900;line-height:1;
          display:flex;align-items:center;justify-content:center;cursor:pointer;
        "
      >&#10005;</button>
      <img
        src="${escapeHtml(viewer.viewUrl)}"
        alt=""
        style="max-width:92vw;max-height:88vh;width:auto;height:auto;object-fit:contain;border-radius:6px;box-shadow:0 24px 64px rgba(0,0,0,0.6);"
      >
      <a
        href="${escapeHtml(viewer.downloadUrl)}"
        download
        style="
          position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom,0));transform:translateX(-50%);z-index:9820;
          display:inline-flex;align-items:center;gap:8px;
          padding:9px 16px;border-radius:20px;border:1px solid rgba(212,165,32,0.4);
          background:rgba(10,10,10,0.78);color:#d4a520;font-size:13px;font-weight:900;text-decoration:none;
        "
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>
        Изтегли
      </a>
    </div>
  `
}

// Скрит file input + видима икона-бутон + thumbnail preview на избраната
// (все още неизпратена) снимка — споделен между desktop и mobile chat форми.
function renderChatImagePickerControls(state: LobbyScreenState, friendshipId: string, forceDisabled = false): string {
  const pending = state.chatPendingImageByFriendshipId[friendshipId]
  const isUploading = state.chatUploadingFriendshipIds.has(friendshipId)
  const isDisabled = isUploading || forceDisabled

  return `
    <input
      type="file"
      accept="image/jpeg,image/png,image/webp"
      data-chat-image-input="${escapeHtml(friendshipId)}"
      style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;"
      ${isDisabled ? 'disabled' : ''}
    >
    <button
      type="button"
      data-chat-image-pick="${escapeHtml(friendshipId)}"
      title="Прикачи снимка"
      aria-label="Прикачи снимка"
      ${isDisabled ? 'disabled' : ''}
      style="height:42px;width:42px;flex:0 0 auto;border:1px solid rgba(212,165,32,0.34);border-radius:8px;background:#050505;color:#d4a520;display:flex;align-items:center;justify-content:center;cursor:${isDisabled ? 'default' : 'pointer'};opacity:${isDisabled ? '0.5' : '1'};"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>
    </button>
    ${pending ? `
      <div style="position:relative;flex:0 0 auto;">
        <img src="${escapeHtml(pending.previewUrl)}" alt="" style="width:42px;height:42px;object-fit:cover;border-radius:8px;border:1px solid rgba(212,165,32,0.48);display:block;">
        <button
          type="button"
          data-chat-image-remove="${escapeHtml(friendshipId)}"
          title="Премахни снимката"
          aria-label="Премахни снимката"
          ${isDisabled ? 'disabled' : ''}
          style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:0;background:#ef4444;color:#fff;font-size:11px;font-weight:900;line-height:1;display:flex;align-items:center;justify-content:center;cursor:${isDisabled ? 'default' : 'pointer'};padding:0;"
        >✕</button>
      </div>
    ` : ''}
  `
}

function renderSupportImagePickerControls(
  pending: { previewUrl: string } | null | undefined,
  isSending: boolean,
  attributes: {
    input: string
    pick: string
    remove: string
  },
): string {
  return `
    <div data-support-image-slot="1">
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        ${attributes.input}
        style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;"
        ${isSending ? 'disabled' : ''}
      >
      <button
        type="button"
        data-support-image-button="1"
        ${attributes.pick}
        title="Прикачи снимка"
        aria-label="Прикачи снимка"
        ${isSending ? 'disabled' : ''}
        style="height:44px;width:44px;border:1px solid rgba(212,165,32,0.34);border-radius:8px;background:#050505;color:#d4a520;display:flex;align-items:center;justify-content:center;cursor:${isSending ? 'default' : 'pointer'};opacity:${isSending ? '0.5' : '1'};"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>
      </button>
      ${pending ? `
        <div data-support-image-preview="1" style="position:absolute;left:0;bottom:calc(100% + 8px);z-index:2;">
        <img src="${escapeHtml(pending.previewUrl)}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:8px;border:1px solid rgba(212,165,32,0.48);display:block;background:#050505;">
        <button
          type="button"
          ${attributes.remove}
          title="Премахни снимката"
          aria-label="Премахни снимката"
          ${isSending ? 'disabled' : ''}
          style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:0;background:#ef4444;color:#fff;font-size:11px;font-weight:900;line-height:1;display:flex;align-items:center;justify-content:center;cursor:${isSending ? 'default' : 'pointer'};padding:0;"
        >×</button>
      </div>
      ` : ''}
    </div>
  `
}

function renderSupportComposerStyles(): string {
  return `
    <style>
      [data-support-composer] {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 44px auto;
        grid-template-areas: "text image send";
        align-items: end;
        gap: 10px;
        max-width: 100%;
        box-sizing: border-box;
      }
      [data-support-composer-text] {
        grid-area: text;
        min-width: 0;
        width: 100%;
        box-sizing: border-box;
      }
      [data-support-image-slot] {
        grid-area: image;
        position: relative;
        width: 44px;
        height: 44px;
        align-self: end;
      }
      [data-support-composer-send] {
        grid-area: send;
        height: 44px;
        min-width: 96px;
        align-self: end;
        box-sizing: border-box;
      }
      @media (max-width: 640px) {
        [data-support-composer] {
          grid-template-columns: 44px minmax(0, 1fr);
          grid-template-areas:
            "text text"
            "image send";
          align-items: stretch;
          padding: 12px;
          gap: 10px;
          overflow-x: hidden;
        }
        [data-support-composer-send] {
          width: 100%;
          min-width: 0;
        }
        [data-support-composer-text] {
          min-height: 66px;
        }
      }
    </style>
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

const LINKIFIED_CHAT_TOKEN_PATTERN = /(\[e:\d{2}\])|(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi
const LINKIFIED_CHAT_TRAILING_LINK_PUNCTUATION = '.,!?;:)]}'

function renderPlainLinkifiedChatText(value: string): string {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, '<br>')
}

function splitTrailingLinkPunctuation(value: string): { linkText: string; trailingText: string } {
  let linkText = value
  let trailingText = ''

  while (
    linkText.length > 0 &&
    LINKIFIED_CHAT_TRAILING_LINK_PUNCTUATION.includes(linkText.charAt(linkText.length - 1))
  ) {
    trailingText = linkText.charAt(linkText.length - 1) + trailingText
    linkText = linkText.slice(0, -1)
  }

  return { linkText, trailingText }
}

function toSafeLinkifiedChatHref(linkText: string): string | null {
  const href = /^www\./i.test(linkText) ? `https://${linkText}` : linkText

  try {
    const url = new URL(href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    return url.href
  } catch {
    return null
  }
}

function renderLinkifiedChatLink(linkText: string): string | null {
  const href = toSafeLinkifiedChatHref(linkText)
  if (href === null) return null

  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" data-chat-link="1" style="color:inherit;text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:2px;text-decoration-color:rgba(59,130,246,0.88);overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(linkText)}</a>`
}

export function renderLinkifiedChatMessageBody(body: string): string {
  let html = ''
  let cursor = 0

  for (const match of body.matchAll(LINKIFIED_CHAT_TOKEN_PATTERN)) {
    const rawToken = match[0]
    const index = match.index ?? 0

    if (index > cursor) {
      html += renderPlainLinkifiedChatText(body.slice(cursor, index))
    }

    const emojiMatch = /^\[e:(\d{2})\]$/.exec(rawToken)
    if (emojiMatch) {
      html += `<img src="/assets/animated-emoji/emoji-${emojiMatch[1]}.webp" alt="" style="width:28px;height:28px;vertical-align:middle;display:inline-block;">`
    } else {
      const { linkText, trailingText } = splitTrailingLinkPunctuation(rawToken)
      const renderedLink = linkText.length > 0 ? renderLinkifiedChatLink(linkText) : null
      html += renderedLink ?? renderPlainLinkifiedChatText(linkText)
      html += renderPlainLinkifiedChatText(trailingText)
    }

    cursor = index + rawToken.length
  }

  if (cursor < body.length) {
    html += renderPlainLinkifiedChatText(body.slice(cursor))
  }

  return html
}

export function renderPersonalChatMessageBody(body: string): string {
  return renderLinkifiedChatMessageBody(body)
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

export function formatPersonalChatUnreadBadgeCount(count: number): string | null {
  return formatNotificationBadgeCount(count)
}

export function getPersonalChatUnreadTotal(state: LobbyScreenState): number {
  return getTopicsPersonalUnreadRaw(state)
}

function renderTopicsPersonalConversationRow(
  conversation: ChatConversationSnapshot,
  activeFriendshipId: string | null,
): string {
  const isActive = activeFriendshipId === conversation.friendshipId
  const displayName = conversation.friend.displayName?.trim() || 'Играч'
  const avatarUrl = conversation.friend.avatarUrl?.trim() ?? ''
  const preview = conversation.lastMessage?.body ?? 'Няма съобщения'
  const activityTime = formatChatTime(conversation.updatedAt)
  const unreadBadge = formatPersonalChatUnreadBadgeCount(conversation.unreadCount)

  return `
    <button
      type="button"
      data-lobby-chat-conversation="${escapeHtml(conversation.friendshipId)}"
      data-topics-personal-row="1"
      ${isActive ? 'data-active="1"' : ''}
      style="
        display:flex;align-items:center;gap:12px;width:100%;border:0;
        border-bottom:1px solid rgba(255,255,255,0.06);
        background:${isActive ? 'rgba(212,165,32,0.12)' : 'transparent'};
        color:#ffffff;text-align:left;padding:12px 14px;cursor:pointer;min-width:0;box-sizing:border-box;
      "
    >
      <div style="position:relative;width:46px;height:46px;flex:0 0 auto;">
        <div style="width:46px;height:46px;border-radius:8px;border:1px solid rgba(212,165,32,0.48);background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:19px;font-weight:900;">
          ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">` : escapeHtml(displayName.charAt(0).toUpperCase() || '?')}
        </div>
        ${conversation.friend.isOnline !== undefined ? `<div style="position:absolute;bottom:-2px;right:-2px;width:11px;height:11px;border-radius:50%;background:${conversation.friend.isOnline ? '#22c55e' : '#ef4444'};border:2px solid #050505;"></div>` : ''}
      </div>
      <div style="min-width:0;flex:1;">
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="font-size:14px;font-weight:900;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;">${escapeHtml(displayName)}</div>
          ${activityTime ? `<span data-topics-personal-row-time="1" style="font-size:10px;font-weight:800;color:rgba(255,255,255,0.38);white-space:nowrap;flex:0 0 auto;">${escapeHtml(activityTime)}</span>` : ''}
          ${unreadBadge !== null ? `<span data-topics-personal-row-badge="1" aria-label="${escapeHtml(`${conversation.unreadCount} непрочетени съобщения`)}" style="min-width:18px;height:18px;border-radius:9px;background:#ef4444;color:#fff;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:center;padding:0 4px;flex-shrink:0;">${escapeHtml(unreadBadge)}</span>` : ''}
        </div>
        <div style="margin-top:4px;font-size:12px;font-weight:700;color:${conversation.unreadCount > 0 ? '#ffffff' : 'rgba(255,255,255,0.54)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(preview)}</div>
      </div>
    </button>
  `
}

function renderTopicsPersonalMessages(state: LobbyScreenState, activeConversation: ChatConversationSnapshot): string {
  const messagesBelongToActiveConversation = state.chatMessagesFriendshipId === activeConversation.friendshipId
  const visibleMessages = messagesBelongToActiveConversation
    ? state.chatMessages.filter((message) => message.friendshipId === activeConversation.friendshipId)
    : []
  const vipDmDisabledReason = activeConversation.kind !== 'vip_dm'
    ? null
    : (state.topicsVipGate?.isActive ?? (state.profile.isVip === true)) !== true
      ? 'За да изпращате лични съобщения тук, е необходим активен VIP.'
      : activeConversation.friend.isVip === false
        ? 'Този потребител в момента не е активен VIP.'
        : activeConversation.friend.isBlockedByMe === true
          ? 'Вие сте блокирали този потребител.'
          : null
  const isComposerDisabled = vipDmDisabledReason !== null || state.chatUploadingFriendshipIds.has(activeConversation.friendshipId)

  return `
    <div data-chat-messages-scroll="1" style="flex:1;min-height:0;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:6px;scrollbar-width:thin;scrollbar-color:#d4a520 #111111;">
      ${state.chatMessagesLoading || !messagesBelongToActiveConversation ? `
        <div style="margin:auto;color:#d4a520;font-size:15px;font-weight:900;">Зареждане...</div>
      ` : visibleMessages.length === 0 ? `
        <div style="margin:auto;color:rgba(255,255,255,0.58);font-size:14px;font-weight:800;text-align:center;">Няма съобщения. Започни разговора.</div>
      ` : visibleMessages.map((message) => {
        const isEmojiOnly = /^(\[e:\d{2}\])+$/.test(message.body.trim())
        const hasText = message.body.trim().length > 0
        return `
          <div style="align-self:${message.isOwnMessage ? 'flex-end' : 'flex-start'};max-width:min(82%,620px);display:grid;gap:3px;">
            ${message.attachment ? `
              <div style="border-radius:8px;background:${message.isOwnMessage ? 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)' : 'rgba(255,255,255,0.08)'};color:${message.isOwnMessage ? '#080808' : '#f8fafc'};padding:6px;display:grid;gap:6px;">
                ${renderChatAttachmentBubble(message.attachment, state.apiBaseUrl)}
                ${hasText ? `<div style="padding:0 4px 2px;font-size:14px;font-weight:800;line-height:1.35;word-break:break-word;">${renderPersonalChatMessageBody(message.body)}</div>` : ''}
              </div>
            ` : `
              <div style="${isEmojiOnly
                ? 'padding:2px;line-height:1;'
                : `border-radius:8px;background:${message.isOwnMessage ? 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)' : 'rgba(255,255,255,0.08)'};color:${message.isOwnMessage ? '#080808' : '#f8fafc'};padding:7px 10px;font-size:14px;font-weight:800;line-height:1.35;word-break:break-word;`}">
                ${isEmojiOnly
                  ? message.body.trim().replace(/\[e:(\d{2})\]/g, (_, n) => `<img src="/assets/animated-emoji/emoji-${n}.webp" alt="" style="width:52px;height:52px;object-fit:contain;display:inline-block;">`)
                  : renderPersonalChatMessageBody(message.body)}
              </div>
            `}
            <div style="font-size:10px;font-weight:800;color:rgba(255,255,255,0.42);text-align:${message.isOwnMessage ? 'right' : 'left'};">${escapeHtml(formatChatTime(message.createdAt))}</div>
          </div>
        `
      }).join('')}
    </div>
    <form data-lobby-chat-form="${escapeHtml(activeConversation.friendshipId)}" data-chat-composer-disabled="${isComposerDisabled ? '1' : '0'}" style="display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-top:1px solid rgba(212,165,32,0.20);flex:0 0 auto;">
      ${vipDmDisabledReason !== null ? `<div data-chat-composer-disabled-reason="1" style="font-size:12px;font-weight:800;color:#fbbf24;line-height:1.35;">${escapeHtml(vipDmDisabledReason)}</div>` : ''}
      <div style="display:flex;gap:10px;align-items:center;">
        ${renderChatImagePickerControls(state, activeConversation.friendshipId, vipDmDisabledReason !== null)}
        <input name="message" data-lobby-chat-message-input="1" value="${escapeHtml(state.chatDraftByFriendshipId[activeConversation.friendshipId] ?? '')}" maxlength="1000" autocomplete="off" placeholder="Напиши съобщение..." ${isComposerDisabled ? 'disabled' : ''} style="height:42px;flex:1;min-width:0;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:700;outline:none;opacity:${isComposerDisabled ? '0.62' : '1'};">
        <button type="submit" data-topics-personal-send="1" aria-label="Изпрати" title="Изпрати" ${isComposerDisabled ? 'disabled' : ''} style="height:42px;width:42px;flex:0 0 42px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:16px;font-weight:900;line-height:1;cursor:${isComposerDisabled ? 'default' : 'pointer'};opacity:${isComposerDisabled ? '0.6' : '1'};"><span aria-hidden="true">&#10148;</span></button>
      </div>
    </form>
  `
}

// Синтетичен ключ, огледален на PENDING_VIP_DM_UPLOAD_KEY в
// createLobbyFlowController.ts — DOM/state ключ за composer/draft/upload,
// докато pending vip_dm compose context (§7 в task spec-а) все още няма
// реален friendshipId.
const PENDING_VIP_DM_UPLOAD_KEY = '__pending_vip_dm__'

// Composer за pending vip_dm compose context — recipient е известен, но
// friendshipId още не съществува (виж §7/§9 в task spec-а). Reuse-ва
// същите data-lobby-chat-form/data-lobby-chat-message-input selectors, само
// с PENDING_VIP_DM_UPLOAD_KEY вместо истински friendshipId — контролерът
// (sendChatMessage) detect-ва този sentinel и route-ва към атомарния
// start+send path вместо обикновения sendMessage(friendshipId, ...).
function renderTopicsPersonalPendingComposer(state: LobbyScreenState, recipientDisplayName: string): string {
  const isUploading = state.chatUploadingFriendshipIds.has(PENDING_VIP_DM_UPLOAD_KEY)
  const isComposerDisabled = isUploading

  return `
    <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(212,165,32,0.24);flex:0 0 auto;">
      <button type="button" data-topics-personal-conversation-back="1" aria-label="Назад към личните разговори" style="align-items:center;justify-content:center;width:34px;height:34px;border:1px solid rgba(212,165,32,0.34);border-radius:8px;background:#050505;color:#d4a520;font-size:18px;font-weight:900;cursor:pointer;">&larr;</button>
      <div style="font-size:18px;font-weight:900;color:#f8fafc;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(recipientDisplayName)}</div>
      ${state.chatErrorText ? `<div style="margin-left:auto;color:#fecaca;font-size:12px;font-weight:800;">${escapeHtml(state.chatErrorText)}</div>` : ''}
    </div>
    <div data-chat-messages-scroll="1" style="flex:1;min-height:0;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:6px;scrollbar-width:thin;scrollbar-color:#d4a520 #111111;">
      <div style="margin:auto;color:rgba(255,255,255,0.58);font-size:14px;font-weight:800;text-align:center;">Няма съобщения. Започни разговора.</div>
    </div>
    <form data-lobby-chat-form="${escapeHtml(PENDING_VIP_DM_UPLOAD_KEY)}" data-chat-composer-disabled="${isComposerDisabled ? '1' : '0'}" style="display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-top:1px solid rgba(212,165,32,0.20);flex:0 0 auto;">
      <div style="display:flex;gap:10px;align-items:center;">
        ${renderChatImagePickerControls(state, PENDING_VIP_DM_UPLOAD_KEY, isComposerDisabled)}
        <input name="message" data-lobby-chat-message-input="1" value="${escapeHtml(state.chatDraftByFriendshipId[PENDING_VIP_DM_UPLOAD_KEY] ?? '')}" maxlength="1000" autocomplete="off" placeholder="Напиши съобщение..." ${isComposerDisabled ? 'disabled' : ''} style="height:42px;flex:1;min-width:0;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:700;outline:none;opacity:${isComposerDisabled ? '0.62' : '1'};">
        <button type="submit" data-topics-personal-send="1" aria-label="Изпрати" title="Изпрати" ${isComposerDisabled ? 'disabled' : ''} style="height:42px;width:42px;flex:0 0 42px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:16px;font-weight:900;line-height:1;cursor:${isComposerDisabled ? 'default' : 'pointer'};opacity:${isComposerDisabled ? '0.6' : '1'};"><span aria-hidden="true">&#10148;</span></button>
      </div>
    </form>
  `
}

export function renderTopicsPersonalChatPanel(state: LobbyScreenState): string {
  // Пълната колекция обслужва identity/detail resolution (напр. току-що
  // създаден празен vip_dm от "Лично", преди да е изпратено първо съобщение) —
  // тя НЕ се render-ва директно като list rows.
  const personalConversations = state.chatConversations
    .filter((conversation) => conversation.kind === 'vip_dm')
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  // Видимите rows в лявата колона показват само разговори с поне 1 съобщение —
  // празен vip_dm (0 съобщения) никога не е list row, само detail/compose context.
  const visiblePersonalConversations = personalConversations.filter(
    (conversation) => conversation.lastMessage !== null,
  )
  const activeConversation = state.topicsPersonalView === 'conversation'
    ? personalConversations.find((conversation) => conversation.friendshipId === state.activeChatFriendshipId) ?? null
    : null

  if (state.chatLoading) {
    return `
      <div data-topics-personal-panel="1" style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:#050505;color:#d4a520;font-size:15px;font-weight:900;">
        Зареждане на лични разговори...
      </div>
    `
  }

  return `
    <style>
      [data-topics-personal-panel="1"] {
        display:grid;
        grid-template-columns:minmax(240px,320px) minmax(0,1fr);
        gap:12px;
      }
      [data-topics-personal-conversation-back="1"] { display:none; }
      @media (max-width: 720px) {
        [data-topics-personal-panel="1"] { display:flex; flex-direction:column; }
        [data-topics-personal-list="1"], [data-topics-personal-detail="1"] { flex:1; min-height:0; }
        [data-topics-personal-panel="1"][data-personal-view="conversation"] [data-topics-personal-list="1"] { display:none !important; }
        [data-topics-personal-panel="1"][data-personal-view="list"] [data-topics-personal-detail="1"] { display:none !important; }
        [data-topics-personal-conversation-back="1"] { display:inline-flex; }
      }
    </style>
    <div data-topics-personal-panel="1" data-personal-view="${state.topicsPersonalView}" style="flex:1;min-height:0;overflow:hidden;">
      <div data-topics-personal-list="1" style="min-height:0;border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:#050505;overflow:hidden;display:flex;flex-direction:column;">
        ${visiblePersonalConversations.length === 0 ? `
          <div data-topics-personal-empty="1" style="margin:auto;padding:24px 16px;color:rgba(255,255,255,0.62);font-size:14px;font-weight:800;text-align:center;display:grid;gap:6px;">
            <div>Нямате лични разговори.</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.45);">Можете да започнете разговор от профила на приятел.</div>
          </div>
        ` : `
          <div style="overflow-y:auto;flex:1;scrollbar-width:thin;scrollbar-color:#d4a520 #111111;">
            ${visiblePersonalConversations.map((conversation) => renderTopicsPersonalConversationRow(conversation, state.activeChatFriendshipId)).join('')}
          </div>
        `}
      </div>
      <div data-topics-personal-detail="1" style="min-width:0;min-height:0;border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:linear-gradient(180deg,#111 0%,#050505 100%);overflow:hidden;display:flex;flex-direction:column;">
        ${activeConversation === null && state.topicsPersonalPendingRecipient !== null ? renderTopicsPersonalPendingComposer(state, state.topicsPersonalPendingRecipient.displayName) : activeConversation === null ? `
          <div style="min-height:260px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.62);font-size:15px;font-weight:800;text-align:center;padding:20px;">
            Избери личен разговор.
          </div>
        ` : `
          <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(212,165,32,0.24);flex:0 0 auto;">
            <button type="button" data-topics-personal-conversation-back="1" aria-label="Назад към личните разговори" style="align-items:center;justify-content:center;width:34px;height:34px;border:1px solid rgba(212,165,32,0.34);border-radius:8px;background:#050505;color:#d4a520;font-size:18px;font-weight:900;cursor:pointer;">&larr;</button>
            <div style="font-size:18px;font-weight:900;color:#f8fafc;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(activeConversation.friend.displayName ?? 'Играч')}</div>
            ${state.chatErrorText ? `<div style="margin-left:auto;color:#fecaca;font-size:12px;font-weight:800;">${escapeHtml(state.chatErrorText)}</div>` : ''}
          </div>
          ${renderTopicsPersonalMessages(state, activeConversation)}
        `}
      </div>
    </div>
  `
}

function renderChatPanel(state: LobbyScreenState): string {
  if (state.chatLoading) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(212,165,32,0.34);background:#050505;border-radius:8px;color:#d4a520;font-size:18px;font-weight:900;">
        Зареждане на чат...
      </div>
    `
  }

  // ВАЖНО: allowlist, НЕ blocklist само на 'vip_dm' — 'vip_dm' изрично се
  // изключва тук, защото има собствен dedicated UI (Topics personal chat,
  // виж renderTopicsPersonalChat/showTopicsPersonalChat). 'pika_support'
  // ТРЯБВА да остане в тоя списък — този панел вече рендира коректно badge
  // и цветове за него (isPikaSupport/pikaSupportBadge по-долу). Изключването
  // му тук (стар filter: === 'friend') беше production regression: активният
  // разговор (activeConversation, търсен по friendshipId в ТОЗИ списък) не
  // го намираше и мълчаливо fallback-ваше към sortedConversations[0] —
  // първия 'friend' разговор по updatedAt — карайки composer формата да праща
  // съобщения в СЪВСЕМ ДРУГ разговор (PIKABG X→Y cross-delivery bug).
  const visibleConversations = (state.chatShowArchived ? state.chatArchivedConversations : state.chatConversations)
    .filter((conversation) => conversation.kind === 'friend' || conversation.kind === 'pika_support')
  const sortedConversations = [...visibleConversations].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )

  const activeConversation = sortedConversations.find(
    (conversation) => conversation.friendshipId === state.activeChatFriendshipId,
  ) ?? (state.chatShowArchived ? null : sortedConversations[0] ?? null)

  const pikaSupportBadge = `
    <span style="display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;background:rgba(239,68,68,0.16);border:1px solid rgba(239,68,68,0.58);color:#ef4444;font-size:9px;font-weight:900;letter-spacing:0.03em;text-transform:uppercase;white-space:nowrap;flex-shrink:0;">Екип Pika.bg</span>
  `

  return `
    <section style="min-height:520px;display:grid;grid-template-columns:300px minmax(0,1fr) 250px;gap:14px;align-content:start;">
      <div style="border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:#050505;overflow:hidden;display:flex;flex-direction:column;max-height:560px;">
        <div style="padding:14px 16px;border-bottom:1px solid rgba(212,165,32,0.24);flex-shrink:0;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div style="font-size:22px;font-weight:900;color:#f8fafc;">${state.chatShowArchived ? 'Архивирани' : 'Чат'}</div>
            <button type="button" data-lobby-chat-toggle-archived="1" style="border:0;background:transparent;color:rgba(212,165,32,0.78);font-size:11px;font-weight:800;cursor:pointer;padding:4px 6px;text-decoration:underline;">
              ${state.chatShowArchived ? '← Активни' : 'Архивирани'}
            </button>
          </div>
          <div style="margin-top:5px;font-size:12px;font-weight:800;color:rgba(255,255,255,0.54);">Само между приятели. Недостъпен по време на игра.</div>
        </div>
        ${state.chatShowArchived && state.chatArchivedLoading ? `
          <div style="padding:24px 16px;color:#d4a520;font-size:14px;font-weight:800;text-align:center;">Зареждане...</div>
        ` : sortedConversations.length === 0 ? `
          <div style="padding:24px 16px;color:rgba(255,255,255,0.62);font-size:14px;font-weight:800;text-align:center;">
            ${state.chatShowArchived ? 'Няма архивирани разговори.' : 'Добави приятели, за да започнеш чат.'}
          </div>
        ` : `
          <div style="overflow-y:auto;flex:1;scrollbar-width:thin;scrollbar-color:#d4a520 #111111;">
            ${sortedConversations.map((conversation) => {
              const isActive = activeConversation?.friendshipId === conversation.friendshipId
              const displayName = conversation.friend.displayName?.trim() || 'Играч'
              const avatarUrl = conversation.friend.avatarUrl?.trim() ?? ''
              const preview = conversation.lastMessage?.body ?? 'Няма съобщения'
              const isOnline = conversation.friend.isOnline
              const isPikaSupport = conversation.kind === 'pika_support'
              const unreadBadge = formatNotificationBadgeCount(conversation.unreadCount)

              return `
                <button type="button" data-lobby-chat-conversation="${escapeHtml(conversation.friendshipId)}" style="display:flex;align-items:center;gap:12px;width:100%;border:0;border-bottom:1px solid rgba(255,255,255,0.06);background:${isActive ? 'rgba(212,165,32,0.12)' : 'transparent'};color:#ffffff;text-align:left;padding:12px 14px;cursor:pointer;min-width:0;box-sizing:border-box;">
                  <div style="position:relative;width:46px;height:46px;flex:0 0 auto;">
                    <div style="width:46px;height:46px;border-radius:8px;border:1px solid ${isPikaSupport ? 'rgba(239,68,68,0.58)' : 'rgba(212,165,32,0.48)'};background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;color:${isPikaSupport ? '#ef4444' : '#d4a520'};font-size:19px;font-weight:900;">
                      ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">` : escapeHtml(displayName.charAt(0).toUpperCase() || '?')}
                    </div>
                    ${isOnline !== undefined ? `<div style="position:absolute;bottom:-2px;right:-2px;width:11px;height:11px;border-radius:50%;background:${isOnline ? '#22c55e' : '#ef4444'};border:2px solid #050505;"></div>` : ''}
                  </div>
                  <div style="min-width:0;flex:1;">
                    <div style="display:flex;align-items:center;gap:6px;">
                      <div style="font-size:14px;font-weight:900;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;">${escapeHtml(displayName)}</div>
                      ${isPikaSupport ? pikaSupportBadge : ''}
                      ${unreadBadge !== null ? `<span style="min-width:18px;height:18px;border-radius:9px;background:#ef4444;color:#fff;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:center;padding:0 4px;flex-shrink:0;">${escapeHtml(unreadBadge)}</span>` : ''}
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
            ${activeConversation.kind === 'pika_support' ? pikaSupportBadge : ''}
            ${state.chatErrorText ? `<div style="margin-left:auto;color:#fecaca;font-size:12px;font-weight:800;">${escapeHtml(state.chatErrorText)}</div>` : ''}
          </div>
          <div data-chat-messages-scroll="1" style="height:350px;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:6px;scrollbar-width:thin;scrollbar-color:#d4a520 #111111;">
            ${state.chatMessagesLoading ? `
              <div style="margin:auto;color:#d4a520;font-size:15px;font-weight:900;">Зареждане...</div>
            ` : state.chatMessages.length === 0 ? `
              <div style="margin:auto;color:rgba(255,255,255,0.58);font-size:14px;font-weight:800;text-align:center;">Няма съобщения. Започни разговора.</div>
            ` : state.chatMessages.map((message) => {
              const isEmojiOnly = /^(\[e:\d{2}\])+$/.test(message.body.trim())
              const hasText = message.body.trim().length > 0
              return `
              <div style="align-self:${message.isOwnMessage ? 'flex-end' : 'flex-start'};max-width:min(72%,620px);display:grid;gap:3px;">
                ${message.attachment ? `
                  <div style="border-radius:8px;background:${message.isOwnMessage ? 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)' : 'rgba(255,255,255,0.08)'};color:${message.isOwnMessage ? '#080808' : '#f8fafc'};padding:6px;display:grid;gap:6px;">
                    ${renderChatAttachmentBubble(message.attachment, state.apiBaseUrl)}
                    ${hasText ? `<div style="padding:0 4px 2px;font-size:14px;font-weight:800;line-height:1.35;word-break:break-word;">${renderPersonalChatMessageBody(message.body)}</div>` : ''}
                  </div>
                ` : `
                  <div style="${isEmojiOnly
                    ? 'padding:2px;line-height:1;'
                    : `border-radius:8px;background:${message.isOwnMessage ? 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)' : 'rgba(255,255,255,0.08)'};color:${message.isOwnMessage ? '#080808' : '#f8fafc'};padding:7px 10px;font-size:14px;font-weight:800;line-height:1.35;word-break:break-word;`}">
                    ${isEmojiOnly
                      ? message.body.trim().replace(/\[e:(\d{2})\]/g, (_, n) => `<img src="/assets/animated-emoji/emoji-${n}.webp" alt="" style="width:52px;height:52px;object-fit:contain;display:inline-block;">`)
                      : renderPersonalChatMessageBody(message.body)}
                  </div>
                `}
                <div style="font-size:10px;font-weight:800;color:rgba(255,255,255,0.42);text-align:${message.isOwnMessage ? 'right' : 'left'};">${escapeHtml(formatChatTime(message.createdAt))}</div>
              </div>
            `}).join('')}
          </div>
          <form data-lobby-chat-form="${escapeHtml(activeConversation.friendshipId)}" style="display:flex;flex-direction:column;gap:8px;padding:14px 16px;border-top:1px solid rgba(212,165,32,0.20);">
            <div style="display:flex;gap:10px;align-items:center;">
              ${renderChatImagePickerControls(state, activeConversation.friendshipId)}
              <input name="message" data-lobby-chat-message-input="1" value="${escapeHtml(state.chatDraftByFriendshipId[activeConversation.friendshipId] ?? '')}" maxlength="1000" autocomplete="off" placeholder="Напиши съобщение..." ${state.chatUploadingFriendshipIds.has(activeConversation.friendshipId) ? 'disabled' : ''} style="height:42px;flex:1;min-width:0;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:700;outline:none;">
              <button type="submit" ${state.chatUploadingFriendshipIds.has(activeConversation.friendshipId) ? 'disabled' : ''} style="height:42px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:14px;font-weight:900;cursor:pointer;opacity:${state.chatUploadingFriendshipIds.has(activeConversation.friendshipId) ? '0.6' : '1'};">${state.chatUploadingFriendshipIds.has(activeConversation.friendshipId) ? 'Качване…' : 'Изпрати'}</button>
            </div>
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

export function renderPlayersDirectory(state: LobbyScreenState): string {
  const { players, isSearchActive } = computePlayersDirectoryLists(state, {
    isAdmin: state.isAdminOrSubadmin,
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
          <div style="font-size:13px;font-weight:900;color:#d4a520;white-space:nowrap;">${formatAmount(state.playersTotalCount)} играчи</div>
        </div>
      </div>

      ${!isSearchActive ? renderPlayersPager(state) : ''}

      ${state.playersTotalCount === 0 ? `
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
                      ${state.isAdminOrSubadmin && player.isOnline !== undefined ? `<div style="font-size:11px;font-weight:800;color:${player.isOnline ? '#4ade80' : '#f87171'};white-space:nowrap;flex-shrink:0;">${player.isOnline ? 'Онлайн' : 'Офлайн'}</div>` : ''}
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

      ${!isSearchActive ? renderPlayersPager(state) : ''}
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

export function renderShopPanel(state: LobbyScreenState): string {
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
        <div style="display:flex;flex-direction:column;gap:12px;">
          ${(() => {
            const packageRows: (typeof packages)[] = []
            for (let i = 0; i < packages.length; i += 5) {
              packageRows.push(packages.slice(i, i + 5))
            }
            return packageRows.map((row) => {
              const rowHasTopOffer = row.some((p) => p.isTopOffer)
              return `
          <div style="display:flex;gap:12px;${rowHasTopOffer ? 'margin-top:14px;' : ''}">
            ${row.map((coinPackage) => {
              const isPurchasing = state.shopPurchaseActionPackageId === coinPackage.packageId
              return `
            <article style="
              position:relative;
              flex:0 0 calc((100% - 48px) / 5);
              min-width:0;
              background:#000000;
              border:1px solid rgba(212,165,32,0.72);
              border-radius:12px;
              padding:16px 14px 14px;
              box-shadow:0 4px 16px rgba(0,0,0,0.3);
            ">
              <img src="${getCoinPackageImage(coinPackage.sortOrder)}" alt="" style="position:absolute;bottom:10px;right:10px;width:76px;height:76px;object-fit:contain;opacity:0.88;pointer-events:none;">

              <button type="button" data-lobby-shop-package="${escapeHtml(coinPackage.packageId)}" ${isPurchasing ? 'disabled' : ''} style="position:absolute;top:14px;right:14px;height:34px;padding:0 14px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:12px;font-weight:900;cursor:${isPurchasing ? 'wait' : 'pointer'};transition:filter 0.15s,transform 0.1s;">
                ${isPurchasing ? 'Зарежда...' : isLoggedIn ? 'Купи пакет' : 'Влез за покупка'}
              </button>

              ${coinPackage.isTopOffer ? renderTopOfferBadge() : ''}

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
                <label style="display:flex;align-items:center;gap:7px;margin-top:7px;cursor:pointer;user-select:none;">
                  <input type="checkbox"
                    data-lobby-shop-package-top-offer="${escapeHtml(coinPackage.packageId)}"
                    ${coinPackage.isTopOffer ? 'checked' : ''}
                    style="width:15px;height:15px;accent-color:#d4a520;cursor:pointer;flex-shrink:0;">
                  <span style="font-size:11px;font-weight:800;color:rgba(212,165,32,0.85);text-transform:uppercase;letter-spacing:0.05em;">Топ оферта</span>
                </label>
              ` : ''}
            </article>
            `
            }).join('')}
          </div>
              `
            }).join('')
          })()}
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

export function renderAdminInfoPanel(state: LobbyScreenState): string {
  if (!state.isAdminOrSubadmin) {
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
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
        <button type="button" data-lobby-nav-admin-tournaments="1" style="min-height:38px;border:1px solid rgba(212,165,32,0.35);background:#111;color:#d4a520;border-radius:8px;padding:0 14px;font-weight:900;cursor:pointer;">Admin турнири</button>
      </div>
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
  if (!state.isAdminOrSubadmin) {
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

export function renderAdminServerPanel(state: LobbyScreenState): string {
  if (!state.isAdminOrSubadmin) {
    return `<div style="min-height:520px;display:flex;align-items:center;justify-content:center;color:#fecaca;font-size:15px;font-weight:800;">Нямаш достъп.</div>`
  }

  const snap = state.adminMonitoringSnapshot
  const errorText = state.adminMonitoringErrorText

  const PHASE_LABELS: Record<string, string> = {
    'bootstrap': 'Подготовка',
    'new-game': 'Нова игра',
    'choose-first-dealer': 'Избор на раздаващ',
    'cutting': 'Разрязване',
    'cut-resolve': 'Разрязване',
    'deal-first-3': 'Раздаване 1-3',
    'deal-next-2': 'Раздаване 4-5',
    'bidding': 'Обявяване',
    'deal-last-3': 'Раздаване 6-8',
    'playing': 'Игра',
    'scoring': 'Резултати',
    'next-round': 'Резултати',
    'match-ended': 'Завършена',
    'finished': 'Завършена',
  }
  const fmtPhase = (phase: string): string => PHASE_LABELS[phase] ?? phase

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
      const label = fmtPhase(phase)
      return `<span style="display:inline-flex;align-items:center;gap:5px;background:rgba(212,165,32,0.12);border:1px solid rgba(212,165,32,0.28);border-radius:20px;padding:3px 10px;font-size:11px;font-weight:800;color:#d4a520;">${escapeHtml(label)}<span style="color:rgba(255,255,255,0.8);">${count}</span></span>`
    }).join('')

  // ── Активни стаи ──
  const fmtAgoShort = (ms: number): string => {
    const sec = Math.max(0, Math.round((Date.now() - ms) / 1000))
    if (sec < 60) return `преди ${sec} сек.`
    const min = Math.floor(sec / 60)
    if (min < 60) return `преди ${min} мин.`
    const hrs = Math.floor(min / 60)
    return `преди ${hrs} ч.`
  }

  const badge = (text: string, color: string, bg: string) =>
    `<span style="display:inline-flex;align-items:center;background:${bg};border:1px solid ${color}44;border-radius:20px;padding:2px 9px;font-size:11px;font-weight:800;color:${color};white-space:nowrap;">${text}</span>`

  const humanBadge = (n: number) => badge(`${n} ${n === 1 ? 'човек' : 'човека'}`, '#22c55e', 'rgba(34,197,94,0.12)')
  const botBadge = (n: number) => badge(`${n} ${n === 1 ? 'бот' : 'бота'}`, '#d4a520', 'rgba(212,165,32,0.12)')
  const disconnectedBadge = (n: number) => badge(`${n} прекъснал${n === 1 ? '' : 'и'}`, '#f59e0b', 'rgba(245,158,11,0.14)')

  const activeRoomsList = snap.rooms
  const botsOnlyRoom = (r: ActiveRoomSnapshot) => isBotsOnlyActiveRoom(r)
  const isStaleRoom = (r: ActiveRoomSnapshot) => isStaleActiveRoom(r)

  let activeRoomsHtml: string
  if (activeRoomsList.length === 0) {
    activeRoomsHtml = `<p style="font-size:12px;color:rgba(255,255,255,0.35);font-style:italic;margin:0;">В момента няма активни игрови стаи.</p>`
  } else {
    const desktopRows = activeRoomsList.map((r) => {
      const stale = isStaleRoom(r)
      const onlyBots = botsOnlyRoom(r)
      const rowBg = stale ? 'rgba(245,158,11,0.05)' : onlyBots ? 'rgba(255,255,255,0.015)' : 'transparent'
      const idShort = escapeHtml(r.roomId.slice(0, 8))
      const idFull = escapeHtml(r.roomId)
      return `
        <tr style="background:${rowBg};">
          <td style="padding:7px 10px 7px 0;white-space:nowrap;">
            <span title="${idFull}" style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.7);font-family:monospace;cursor:default;">${idShort}</span>
            ${stale ? `<span title="Няма свързани играчи и активност от над 5 минути." style="margin-left:6px;font-size:10px;font-weight:800;color:#f59e0b;">⚠ стара</span>` : ''}
          </td>
          <td style="padding:7px 10px;white-space:nowrap;font-size:12px;font-weight:700;color:#fff;">${escapeHtml(fmtPhase(r.phase))}</td>
          <td style="padding:7px 10px;white-space:nowrap;">
            <div style="display:flex;gap:5px;flex-wrap:wrap;">
              ${humanBadge(r.connectedHumans)}
              ${botBadge(r.bots)}
              ${r.disconnectedHumans > 0 ? disconnectedBadge(r.disconnectedHumans) : ''}
            </div>
          </td>
          <td style="padding:7px 10px;white-space:nowrap;font-size:11px;color:rgba(255,255,255,0.45);">${escapeHtml(r.workerId ?? '—')}</td>
          <td style="padding:7px 0 7px 10px;white-space:nowrap;font-size:11px;color:rgba(255,255,255,0.4);">${fmtAgoShort(r.lastActivityAt)}</td>
        </tr>
      `
    }).join('')

    const desktopTable = `
      <div class="admin-rooms-desktop" style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.08);">
              <th style="text-align:left;padding:5px 10px 5px 0;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);">Стая</th>
              <th style="text-align:left;padding:5px 10px;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);">Фаза</th>
              <th style="text-align:left;padding:5px 10px;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);">Места</th>
              <th style="text-align:left;padding:5px 10px;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);">Worker</th>
              <th style="text-align:left;padding:5px 0 5px 10px;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);">Активност</th>
            </tr>
          </thead>
          <tbody>${desktopRows}</tbody>
        </table>
      </div>
    `

    const mobileCards = activeRoomsList.map((r) => {
      const stale = isStaleRoom(r)
      const onlyBots = botsOnlyRoom(r)
      const cardBg = stale ? 'rgba(245,158,11,0.06)' : onlyBots ? '#0a0a0a' : '#111111'
      const idShort = escapeHtml(r.roomId.slice(0, 8))
      const idFull = escapeHtml(r.roomId)
      return `
        <div style="background:${cardBg};border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px 12px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span title="${idFull}" style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.7);font-family:monospace;">${idShort}</span>
            <span style="font-size:12px;font-weight:800;color:#fff;">${escapeHtml(fmtPhase(r.phase))}${stale ? ' <span style="color:#f59e0b;">⚠</span>' : ''}</span>
          </div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px;">
            ${humanBadge(r.connectedHumans)}
            ${botBadge(r.bots)}
            ${r.disconnectedHumans > 0 ? disconnectedBadge(r.disconnectedHumans) : ''}
          </div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:rgba(255,255,255,0.4);">
            <span>${escapeHtml(r.workerId ?? '—')}</span>
            <span>${fmtAgoShort(r.lastActivityAt)}</span>
          </div>
        </div>
      `
    }).join('')

    activeRoomsHtml = `
      ${desktopTable}
      <div class="admin-rooms-mobile">${mobileCards}</div>
    `
  }

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
      <style>
        @media(max-width:700px){.admin-rooms-desktop{display:none!important;}}
        @media(min-width:701px){.admin-rooms-mobile{display:none!important;}}
      </style>

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

      <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:10px;padding:14px 18px;margin-bottom:20px;">
        ${sectionLabel('Активни стаи')}
        ${activeRoomsHtml}
      </div>

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

export function renderAdminPanel(state: LobbyScreenState, isMobile = false): string {
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
                <label style="display:flex;align-items:center;gap:5px;cursor:pointer;user-select:none;white-space:nowrap;" title="Топ оферта">
                  <input type="checkbox"
                    data-lobby-admin-package-top-offer="${escapeHtml(coinPackage.packageId)}"
                    ${coinPackage.isTopOffer ? 'checked' : ''}
                    style="width:15px;height:15px;accent-color:#d4a520;cursor:pointer;flex-shrink:0;">
                  <span style="font-size:10px;font-weight:800;color:rgba(212,165,32,0.85);text-transform:uppercase;letter-spacing:0.05em;">Топ оферта</span>
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
          <label style="grid-column:1 / -1;display:flex;align-items:center;gap:10px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;cursor:pointer;">
            <input name="isTopOffer" type="checkbox" ${editPackage?.isTopOffer ? 'checked' : ''} style="width:16px;height:16px;accent-color:#d4a520;cursor:pointer;flex-shrink:0;">
            Топ оферта
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

export function renderSupportMessagesBubbles(messages: SupportMessageSnapshot[], loading: boolean, apiBaseUrl: string): string {
  if (loading) {
    return `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:14px;font-weight:800;">Зареждане...</div>`
  }
  if (messages.length === 0) {
    return `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.38);font-size:14px;font-weight:700;text-align:center;padding:24px;">Все още няма съобщения.<br>Изпрати ни запитване.</div>`
  }
  return messages.map((msg) => {
    const hasBody = msg.body.trim().length > 0
    return `
    <div style="display:flex;flex-direction:column;align-items:${msg.isFromAdmin ? 'flex-start' : 'flex-end'};gap:3px;">
      <div style="
        max-width:75%;padding:${hasBody ? '10px 14px' : '8px'};
        border-radius:${msg.isFromAdmin ? '4px 14px 14px 14px' : '14px 4px 14px 14px'};
        background:${msg.isFromAdmin ? 'rgba(212,165,32,0.14)' : '#1e1e1e'};
        border:1px solid ${msg.isFromAdmin ? 'rgba(212,165,32,0.30)' : 'rgba(255,255,255,0.10)'};
        color:#f8fafc;font-size:14px;font-weight:600;line-height:1.55;word-break:break-word;
      ">
        ${msg.attachment ? renderChatAttachmentBubble(msg.attachment, apiBaseUrl) : ''}
        ${hasBody ? `<div style="${msg.attachment ? 'margin-top:8px;' : ''}">${renderLinkifiedChatMessageBody(msg.body)}</div>` : ''}
      </div>
      <div style="font-size:11px;color:rgba(255,255,255,0.35);font-weight:600;padding:0 4px;">
        ${msg.isFromAdmin ? '<span style="color:rgba(212,165,32,0.7);">Екип Pika.bg</span> · ' : ''}${formatSupportTime(msg.createdAt)}
      </div>
    </div>
  `
  }).join('')
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
          ${renderSupportMessagesBubbles(state.supportMessages, state.supportLoading, state.apiBaseUrl)}
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
        ${renderSupportComposerStyles()}
        <form data-support-composer="user" data-support-send-form="1" data-support-has-pending-image="${state.supportPendingImage ? '1' : '0'}" style="
          padding:14px 16px;
          border-top:1px solid rgba(255,255,255,0.10);
          background:#080808;flex-shrink:0;
        ">
          <input name="website" tabindex="-1" autocomplete="off" style="display:none;position:absolute;left:-9999px;">
          <textarea data-support-composer-text="1" name="body" placeholder="Напиши съобщение..." rows="2" maxlength="2000" style="
            border-radius:8px;border:1px solid rgba(255,255,255,0.15);
            background:#141414;color:#f8fafc;
            padding:10px 12px;font-size:14px;font-weight:600;
            outline:none;resize:none;font-family:inherit;line-height:1.4;
          ">${escapeHtml(state.supportDraft)}</textarea>
          ${renderSupportImagePickerControls(state.supportPendingImage, state.supportSendingLoading, {
            input: 'data-support-image-input="1"',
            pick: 'data-support-image-pick="1"',
            remove: 'data-support-image-remove="1"',
          })}
          <button data-support-composer-send="1" type="submit" ${state.supportSendingLoading ? 'disabled' : ''} style="
            padding:0 20px;border:0;border-radius:8px;
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

export function renderAdminSupportPage(state: LobbyScreenState, isMobile = false): string {
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

  const selectedAvatarHtml = selectedConv?.avatarUrl
    ? `<img src="${selectedConv.avatarUrl}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;">`
    : `<div style="width:32px;height:32px;border-radius:50%;background:rgba(212,165,32,0.15);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">👤</div>`

  const deleteConfirmBlockHtml = isDeleteConfirming ? `
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
        <button data-admin-support-delete-confirm="${escapeHtml(state.adminSupportSelectedProfileId ?? '')}"
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
    ` : ''

  const selectedProfileId = state.adminSupportSelectedProfileId ?? ''
  const adminReplyDraft = selectedProfileId ? (state.adminSupportReplyDraftByProfileId[selectedProfileId] ?? '') : ''
  const adminPendingImage = selectedProfileId ? state.adminSupportPendingImageByProfileId[selectedProfileId] : null
  const replyFormHtml = `
    ${renderSupportComposerStyles()}
    ${state.adminSupportReplyErrorText ? `
      <div style="padding:8px 16px;background:rgba(127,29,29,0.42);border-top:1px solid rgba(248,113,113,0.22);color:#fecaca;font-size:12px;font-weight:800;flex-shrink:0;">
        ${escapeHtml(state.adminSupportReplyErrorText)}
      </div>
    ` : ''}
    <form data-support-composer="admin" data-admin-support-reply-form="${escapeHtml(selectedProfileId)}" data-admin-support-has-pending-image="${adminPendingImage ? '1' : '0'}" style="
      padding:14px 16px;
      border-top:1px solid rgba(255,255,255,0.10);
      background:#080808;flex-shrink:0;
    ">
      <textarea data-support-composer-text="1" name="body" placeholder="Отговор от екипа..." rows="2" maxlength="2000" style="
        border-radius:8px;border:1px solid rgba(255,255,255,0.15);
        background:#141414;color:#f8fafc;
        padding:10px 12px;font-size:14px;font-weight:600;
        outline:none;resize:none;font-family:inherit;line-height:1.4;
      ">${escapeHtml(adminReplyDraft)}</textarea>
      ${renderSupportImagePickerControls(adminPendingImage, state.adminSupportReplyLoading, {
        input: `data-admin-support-image-input="${escapeHtml(selectedProfileId)}"`,
        pick: `data-admin-support-image-pick="${escapeHtml(selectedProfileId)}"`,
        remove: `data-admin-support-image-remove="${escapeHtml(selectedProfileId)}"`,
      })}
      <button data-support-composer-send="1" type="submit" ${state.adminSupportReplyLoading ? 'disabled' : ''} style="
        padding:0 20px;border:0;border-radius:8px;
        background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
        color:#080808;font-size:14px;font-weight:900;cursor:pointer;white-space:nowrap;
        opacity:${state.adminSupportReplyLoading ? '0.6' : '1'};
      ">Изпрати</button>
    </form>
  `

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
      <button data-admin-support-delete="${escapeHtml(state.adminSupportSelectedProfileId ?? '')}" style="
        display:flex;align-items:center;gap:6px;
        background:rgba(212,165,32,0.10);border:1px solid rgba(212,165,32,0.30);
        border-radius:7px;padding:6px 12px;cursor:pointer;
        color:#d4a520;font-size:12px;font-weight:800;
      ">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
        Архивирай
      </button>
    </div>

    ${deleteConfirmBlockHtml}

    <div id="support-admin-messages-scroll" style="
      flex:1;min-height:0;overflow-y:auto;padding:20px;
      display:flex;flex-direction:column;gap:10px;
    ">
      ${renderSupportMessagesBubbles(state.adminSupportMessages, state.adminSupportMessagesLoading, state.apiBaseUrl)}
    </div>
    ${replyFormHtml}
  `

  const totalUnread = state.adminSupportConversations.reduce((s, c) => s + c.unreadByAdmin, 0)

  const headerHtml = `
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
  `

  if (isMobile) {
    if (state.adminSupportMobileConversationOpen && state.adminSupportSelectedProfileId !== null) {
      const selectedProfileId = state.adminSupportSelectedProfileId
      return `
        <section style="display:flex;flex-direction:column;">
          <div style="
            display:flex;align-items:center;justify-content:space-between;gap:10px;
            padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.08);
            background:#0a0a0a;
          ">
            <div style="display:flex;align-items:center;gap:10px;min-width:0;">
              <button type="button" data-admin-support-mobile-back="1" style="
                display:flex;align-items:center;justify-content:center;
                width:32px;height:32px;flex-shrink:0;
                background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.72);padding:0;
              ">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              ${selectedAvatarHtml}
              <div style="font-size:15px;font-weight:800;color:#f8fafc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">
                ${escapeHtml(selectedConv?.displayName ?? '')}
              </div>
            </div>
            <button data-admin-support-delete="${escapeHtml(selectedProfileId)}" style="
              display:flex;align-items:center;gap:6px;flex-shrink:0;
              background:rgba(212,165,32,0.10);border:1px solid rgba(212,165,32,0.30);
              border-radius:7px;padding:6px 10px;cursor:pointer;
              color:#d4a520;font-size:11px;font-weight:800;
            ">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
              Архивирай
            </button>
          </div>

          ${deleteConfirmBlockHtml}

          <div id="support-admin-messages-scroll" style="
            max-height:52vh;overflow-y:auto;padding:16px;
            display:flex;flex-direction:column;gap:10px;
          ">
            ${renderSupportMessagesBubbles(state.adminSupportMessages, state.adminSupportMessagesLoading, state.apiBaseUrl)}
          </div>
          ${replyFormHtml}
        </section>
      `
    }

    return `
      <section style="display:flex;flex-direction:column;">
        ${headerHtml}
        <div data-admin-support-mobile-list-scroll="1" style="overflow-y:auto;max-height:calc(100vh - 190px);">
          ${convListHtml}
        </div>
      </section>
    `
  }

  return `
    <section style="height:calc(100vh - 160px);display:flex;flex-direction:column;gap:0;min-height:500px;">
      ${headerHtml}

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
  // Реконсилиран spot-check срещу canonical private_rooms_list — ако
  // state.myPrivateRoom сочи стая, която вече не е в списъка (изтекла/
  // затворена/играта е стартирала), третираме го тук като "нямам маса" за
  // целите на списъка (ordering + "ВЛЕЗ" + "already seated" guard), без да
  // блокираме join към други маси заради stale race. Самото state.myPrivateRoom
  // се коригира отделно чрез private_room_left/expired/closed съобщенията —
  // това е допълнителна defensive проверка само за render-а тук.
  const myRoom = state.myPrivateRoom !== null && state.privateRooms.some((r) => r.id === state.myPrivateRoom!.id)
    ? state.myPrivateRoom
    : null
  const hasMyRoom = myRoom !== null

  const TEAM_SLOT_CSS = `
    .prl-teams {
      display:grid;
      grid-template-columns:1fr auto 1fr;
      gap:clamp(6px, 2vw, 14px);
      align-items:start;
    }
    .prl-team-label {
      font-size:10px;
      font-weight:800;
      letter-spacing:0.04em;
      color:rgba(255,255,255,0.45);
      text-align:center;
      margin-bottom:6px;
    }
    .prl-team-slots {
      display:grid;
      grid-template-columns:1fr;
      gap:clamp(6px, 2vw, 10px);
    }
    .prl-divider {
      width:1px;
      align-self:stretch;
      background:rgba(255,255,255,0.10);
    }
    .prl-slot-occupant {
      display:flex;
      align-items:center;
      gap:8px;
      min-width:0;
      width:100%;
    }
    .prl-slot-avatar-wrap {
      position:relative;
      box-sizing:border-box;
      width:clamp(32px, 9vw, 40px);
      height:clamp(32px, 9vw, 40px);
      flex-shrink:0;
      border-radius:9px;
      overflow:visible;
      background:rgba(255,255,255,0.08);
      border:1px solid rgba(255,255,255,0.15);
    }
    .prl-slot-name {
      font-size:11px;
      color:rgba(255,255,255,0.65);
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      min-width:0;
    }
    .prl-slot-plus {
      box-sizing:border-box;
      width:100%;
      height:clamp(32px, 9vw, 40px);
      min-height:40px;
      border-radius:9px;
      display:flex;
      align-items:center;
      justify-content:center;
      font-size:18px;
      font-weight:900;
    }
    button.prl-slot-plus {
      border:1px dashed rgba(167,139,250,0.5);
      background:rgba(167,139,250,0.10);
      color:#a78bfa;
      cursor:pointer;
    }
    button.prl-slot-plus:hover {
      background:rgba(167,139,250,0.2);
    }
    div.prl-slot-plus {
      border:1px dashed rgba(255,255,255,0.12);
      background:rgba(255,255,255,0.04);
      color:rgba(255,255,255,0.25);
    }
  `

  const roomRowHtml = (room: PrivateRoomSnapshot): string => {
    const timeLeft = Math.max(0, room.expiresAt - Date.now())
    const minutesLeft = Math.ceil(timeLeft / 60000)
    const isLocked = room.kind === 'locked'
    const isMine = room.id === myRoom?.id

    const occupiedCount = room.slots.filter((s) => s.occupant !== null).length
    const hostOccupant = room.slots.map((s) => s.occupant).find((o) => o?.isHost === true) ?? null

    const teamSlotHtml = (team: Team, slotIndex: 0 | 1): string => {
      const slot = room.slots.find((s) => s.team === team && s.slotIndex === slotIndex)
      const occupant = slot?.occupant ?? null

      if (occupant) {
        const avatarInner = occupant.avatarUrl
          ? `<img src="${occupant.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:9px;" />`
          : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:16px;color:rgba(255,255,255,0.5);">${occupant.isBot ? '🤖' : '👤'}</div>`
        const hostBadge = occupant.isHost
          ? `<div style="position:absolute;top:-4px;right:-4px;background:#f59e0b;border-radius:50%;width:14px;height:14px;display:flex;align-items:center;justify-content:center;font-size:8px;">★</div>`
          : ''
        const slotInnerHtml = `
            <div class="prl-slot-avatar-wrap">
              <div style="width:100%;height:100%;border-radius:9px;overflow:hidden;">${avatarInner}</div>
              ${hostBadge}
            </div>
            <div class="prl-slot-name">${escapeHtml(occupant.displayName)}</div>`

        // Заетите места отварят profile popup-а САМО ако участникът има реален
        // profileId (бот/временен гост без профил остава некликаем). Отделен
        // <button> от "+"-а по-долу — кликът тук никога не buble-ва към join.
        if (!occupant.isBot && occupant.profileId) {
          return `
          <button
            type="button"
            data-private-room-member="${escapeHtml(occupant.profileId)}"
            data-private-room-member-name="${escapeHtml(occupant.displayName)}"
            aria-label="Профил на ${escapeHtml(occupant.displayName)}"
            class="prl-slot-occupant"
            style="border:0;background:transparent;padding:0;cursor:pointer;"
          >${slotInnerHtml}
          </button>`
        }

        return `<div class="prl-slot-occupant">${slotInnerHtml}</div>`
      }

      // Свободен слот. Кликаем "+" само когато: не е собствената ми маса
      // (за own room "+" е чисто визуален — виж §8 от спецификацията) и
      // масата е "open" (заключените маси пазят старото поведение — никакво
      // взаимодействие със слот без покана/authorization, сървърът си остава
      // единствен authority, тук просто не даваме UI да го подканя).
      if (!isMine && !isLocked) {
        return `<button type="button" class="prl-slot-plus" data-private-room-list-slot-join="${room.id}:${team}:${slotIndex}" aria-label="Заеми място в Отбор ${team === 'A' ? 'А' : 'Б'}">+</button>`
      }
      return `<div class="prl-slot-plus">+</div>`
    }

    const teamsHtml = `
      <div class="prl-teams">
        <div>
          <div class="prl-team-label">ОТБОР А</div>
          <div class="prl-team-slots">${teamSlotHtml('A', 0)}${teamSlotHtml('A', 1)}</div>
        </div>
        <div class="prl-divider"></div>
        <div>
          <div class="prl-team-label">ОТБОР Б</div>
          <div class="prl-team-slots">${teamSlotHtml('B', 0)}${teamSlotHtml('B', 1)}</div>
        </div>
      </div>
    `

    const headerActionHtml = isMine
      ? `
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
          <button type="button" data-private-room-list-enter="${room.id}" style="
            padding:7px 20px;border:0;background:linear-gradient(180deg, #f4c95b 0%, #c98f13 100%);
            border-radius:9px;color:#101010;font-size:13px;font-weight:900;cursor:pointer;white-space:nowrap;
          ">ВЛЕЗ</button>
          ${isLocked && occupiedCount < 4
            ? `<button type="button" data-private-room-invite-open="1" style="
                padding:5px 12px;border:1px solid rgba(167,139,250,0.5);background:rgba(167,139,250,0.12);
                border-radius:8px;color:#a78bfa;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;
              ">+ Покани приятели</button>`
            : ''}
        </div>`
      : (isLocked
          ? `<div style="font-size:12px;color:rgba(239,68,68,0.7);font-weight:600;padding:5px 12px;border:1px solid rgba(239,68,68,0.25);border-radius:8px;">Заключена</div>`
          : '')

    return `
      <div style="box-sizing:border-box;width:100%;padding:12px 16px;background:rgba(255,255,255,0.04);border-radius:12px;border:1px solid ${isMine ? 'rgba(244,201,91,0.35)' : 'rgba(255,255,255,0.08)'};overflow:hidden;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
          <div style="flex:1;min-width:0;">
            ${isMine ? `<div style="font-size:10px;font-weight:800;letter-spacing:0.04em;color:#f4c95b;margin-bottom:2px;">ТВОЯТА МАСА</div>` : ''}
            <div style="font-size:14px;font-weight:700;color:#fff;">
              ${hostOccupant?.displayName ?? 'Неизвестен'}
            </div>
            <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:3px;">
              Вход ${formatStake(room.stake)} жълт. · ${occupiedCount}/4 места · ~${minutesLeft} мин.
              ${isLocked ? ' · <span style="color:rgba(239,68,68,0.8);">Заключена</span>' : ''}
            </div>
          </div>
          ${headerActionHtml}
        </div>
        ${teamsHtml}
      </div>
    `
  }

  const allRooms = [
    ...state.privateRooms.filter(r => r.id === myRoom?.id),
    ...state.privateRooms.filter(r => r.id !== myRoom?.id && r.kind === 'open'),
    ...state.privateRooms.filter(r => r.id !== myRoom?.id && r.kind === 'locked'),
  ]
  const allRoomsHtml = allRooms.map(roomRowHtml).join('')

  const hasNoConfiguredStakes = !state.matchRoomsLoading && !state.matchRooms.some((r) => r.isEnabled)
  const createBtnDisabled = hasMyRoom || hasNoConfiguredStakes
  const createBtnHtml = `
      <button type="button" data-private-rooms-create-open="1" ${createBtnDisabled ? 'disabled' : ''} style="
        padding:8px 20px;background:rgba(167,139,250,0.18);border:1px solid rgba(167,139,250,0.55);
        border-radius:10px;color:#a78bfa;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;
        opacity:${createBtnDisabled ? '0.5' : '1'};
      " ${hasNoConfiguredStakes ? 'title="В момента няма налични конфигурирани залози за частни маси."' : ''}>+ Създай маса</button>
    `

  const allTabContent = allRooms.length > 0
    ? `<div style="display:flex;flex-direction:column;gap:8px;">${allRoomsHtml}</div>`
    : `<div style="text-align:center;color:rgba(255,255,255,0.3);font-size:14px;padding:40px 0;">Няма активни маси в момента.</div>`

  return `
    <style>
      [data-private-room-member] { transition: filter 120ms ease, transform 120ms ease; }
      [data-private-room-member]:hover { filter: brightness(1.18); transform: translateY(-1px); }
      ${TEAM_SLOT_CSS}
      ${PRIVATE_ROOM_POPUP_STYLES}
    </style>
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

      <!-- Съдържание -->
      ${allTabContent}
    </div>

    ${renderPrivateRoomsCreatePopup(state)}
    ${renderPrivateRoomJoinConfirmPopup(state.privateRoomJoinSlotPopup)}
    ${renderPrivateRoomBlockedPopup(state.privateRoomBlockedPopupText)}
  `
}

function renderPrivateRoomsCreatePopup(state: LobbyScreenState): string {
  if (!state.privateRoomsCreatePopupOpen) return ''

  const AVAILABLE_STAKES: MatchStake[] = state.matchRooms
    .filter((r) => r.isEnabled)
    .map((r) => r.stakeAmount)
  const WAIT_MINUTES_OPTIONS: Array<5 | 10 | 15 | 30> = [5, 10, 15, 30]
  const DEFAULT_WAIT_MINUTES = 15

  if (AVAILABLE_STAKES.length === 0) {
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
          <div style="font-size:14px;color:rgba(255,255,255,0.6);text-align:center;padding:12px 0 4px;">
            В момента няма налични конфигурирани залози за частни маси.
          </div>
        </div>
      </div>
    `
  }

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
              ${AVAILABLE_STAKES.map((s) => `<option value="${s}">${formatStake(s)} жълтици</option>`).join('')}
            </select>
          </div>
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none;">
            <input type="checkbox" name="isLocked" style="width:17px;height:17px;cursor:pointer;accent-color:#a78bfa;">
            <span style="font-size:13px;color:rgba(255,255,255,0.7);">Заключена маса <span style="color:rgba(255,255,255,0.4);">(само с покана)</span></span>
          </label>
          <div>
            <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">Време за изчакване на играчи</div>
            <select name="waitMinutes" style="
              width:100%;padding:10px 12px;background:#2a2a3e;
              border:1px solid rgba(255,255,255,0.2);border-radius:9px;color:#fff;font-size:14px;
              color-scheme:dark;
            ">
              ${WAIT_MINUTES_OPTIONS.map((m) => `<option value="${m}"${m === DEFAULT_WAIT_MINUTES ? ' selected' : ''}>${m} минути</option>`).join('')}
            </select>
          </div>
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


// Показва се, когато потребител, вече чакащ в частна маса (state.myPrivateRoom
// !== null — може да е стигнал дотук през "Изчакай в лоби"), се опита
// паралелно да стартира matchmaking, да се присъедини към друга частна маса
// или да създаде нова, или да приеме покана за друга маса. Server-side
// guard-овете (privateRoomsStore.ts connectionToRoom проверки) вече отхвърлят
// това еднозначно — тук просто пресрещаме опита клиентски, за да не пращаме
// обречена команда и да покажем ясен път назад, БЕЗ да напускаме текущата
// маса автоматично.
function renderPrivateRoomConflictPopup(state: LobbyScreenState): string {
  if (!state.privateRoomConflictPromptOpen) return ''
  // 'list-join' — "+" клик на ДРУГА маса, докато вече си седнал/имаш
  // запазено място в своя — договорено bespoke копие. Primary бутонът
  // ползва СЪЩИЯ data-private-room-conflict-return handler (чист
  // returnToPrivateRoomWaiting() — само навигация, без нов join и без
  // промяна на seat/team/bots), само етикетът е различен. 'generic' —
  // трите други конфликтни точки (matchmaking/create/invite-accept) —
  // непроменен споделен текст.
  const isListJoin = state.privateRoomConflictPromptVariant === 'list-join'
  const titleHtml = isListJoin
    ? `
      <div style="font-size:18px;font-weight:900;color:#fff;margin-bottom:6px;">Вече сте седнал на друга маса</div>
      <div style="font-size:14px;font-weight:600;color:rgba(255,255,255,0.62);margin-bottom:14px;">Вече имате запазено място в друга частна маса.</div>
    `
    : `<div style="font-size:18px;font-weight:900;color:#fff;margin-bottom:14px;">Вече чакаш в частна маса.</div>`
  const primaryLabel = isListJoin ? 'Виж масата' : 'Върни се'
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
        ${titleHtml}
        <div style="display:flex;gap:12px;">
          <button type="button" data-private-room-conflict-dismiss="1" style="
            flex:1;padding:11px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);
            border-radius:10px;color:rgba(255,255,255,0.7);font-size:14px;font-weight:700;cursor:pointer;
          ">Затвори</button>
          <button type="button" data-private-room-conflict-return="1" style="
            flex:1;padding:11px;border:0;
            background:linear-gradient(180deg, #f4c95b 0%, #c98f13 100%);
            border-radius:10px;color:#101010;font-size:14px;font-weight:800;cursor:pointer;
          ">${primaryLabel}</button>
        </div>
      </div>
    </div>
  `
}

export function renderSubadminActionConfirmPopup(state: LobbyScreenState): string {
  const pending = state.subadminActionConfirm
  if (!pending) return ''

  const isGrant = pending.action === 'grant'
  const title = isGrant ? 'Направи субадмин?' : 'Премахни субадмин?'
  const baseMessage = isGrant
    ? 'Потребителят ще получи достъп само за преглед до секциите „Информация“ и „Сървър“. Няма да може да редактира профили, да чете чата с поддръжката или да променя настройки.'
    : 'Потребителят ще загуби достъпа до административните секции „Информация“ и „Сървър“.'
  const message = isGrant && pending.previousRole === 'chat_admin'
    ? `${baseMessage} Текущата роля „Чат админ“ ще бъде заменена.`
    : baseMessage
  const confirmLabel = isGrant ? 'Направи субадмин' : 'Премахни'
  const busy = state.subadminActionBusy

  return `
    <div style="
      position:fixed;inset:0;z-index:9600;
      display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.7);
    ">
      <div style="
        background:#1a1a2e;border:1px solid rgba(212,165,32,0.35);
        border-radius:16px;padding:28px 28px 24px;max-width:400px;width:90%;
        box-shadow:0 20px 60px rgba(0,0,0,0.6);
      ">
        <div style="font-size:18px;font-weight:900;color:#fff;margin-bottom:14px;">${escapeHtml(title)}</div>
        <div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.5;margin-bottom:24px;">${escapeHtml(message)}</div>
        <div style="display:flex;gap:12px;">
          <button type="button" data-subadmin-action-cancel="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);
            border-radius:10px;color:rgba(255,255,255,0.7);font-size:14px;font-weight:700;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.6' : '1'};
          ">Отказ</button>
          <button type="button" data-subadmin-action-confirm="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(212,165,32,0.62);
            background:linear-gradient(180deg, rgba(244,201,91,0.98) 0%, rgba(201,143,19,0.98) 100%);
            border-radius:10px;color:#080808;font-size:14px;font-weight:900;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.7' : '1'};
          ">${busy ? 'Изчакай…' : escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    </div>
  `
}

export function renderSubadminActionToast(state: LobbyScreenState): string {
  const toast = state.subadminActionToast
  if (!toast) return ''

  return `
    <div style="
      position:fixed;inset:0;z-index:9700;
      display:flex;align-items:flex-end;justify-content:center;
      padding-bottom:64px;
      pointer-events:none;
    ">
      <div style="
        pointer-events:auto;
        background:#1a1a2e;
        border:1px solid ${toast.ok ? 'rgba(212,165,32,0.55)' : 'rgba(239,68,68,0.55)'};
        border-radius:12px;
        padding:14px 22px;
        text-align:center;
        box-shadow:0 8px 40px rgba(0,0,0,0.7);
        max-width:calc(100vw - 48px);
        animation:prInfoIn 0.18s ease both;
      ">
        <div style="font-size:14px;font-weight:800;color:${toast.ok ? '#fde68a' : '#fca5a5'};">${escapeHtml(toast.text)}</div>
      </div>
    </div>
  `
}

/** Огледално на renderSubadminActionConfirmPopup, но за chat_admin роля — виж коментара там за switch-предупреждението. */
export function renderChatAdminActionConfirmPopup(state: LobbyScreenState): string {
  const pending = state.chatAdminActionConfirm
  if (!pending) return ''

  const isGrant = pending.action === 'grant'
  const title = isGrant ? 'Направи чат админ?' : 'Премахни чат админ?'
  const baseMessage = isGrant
    ? 'Потребителят ще може да трие потребителски съобщения от общия чат в лобито. Няма да получи достъп до администраторското меню, статистики, настройки или чужди профили.'
    : 'Потребителят ще загуби правото да трие съобщения от общия чат в лобито.'
  const message = isGrant && pending.previousRole === 'subadmin'
    ? `${baseMessage} Текущата роля „Субадмин“ ще бъде заменена.`
    : baseMessage
  const confirmLabel = isGrant ? 'Направи чат админ' : 'Премахни'
  const busy = state.chatAdminActionBusy

  return `
    <div style="
      position:fixed;inset:0;z-index:9600;
      display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.7);
    ">
      <div style="
        background:#1a1a2e;border:1px solid rgba(212,165,32,0.35);
        border-radius:16px;padding:28px 28px 24px;max-width:400px;width:90%;
        box-shadow:0 20px 60px rgba(0,0,0,0.6);
      ">
        <div style="font-size:18px;font-weight:900;color:#fff;margin-bottom:14px;">${escapeHtml(title)}</div>
        <div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.5;margin-bottom:24px;">${escapeHtml(message)}</div>
        <div style="display:flex;gap:12px;">
          <button type="button" data-chat-admin-action-cancel="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);
            border-radius:10px;color:rgba(255,255,255,0.7);font-size:14px;font-weight:700;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.6' : '1'};
          ">Отказ</button>
          <button type="button" data-chat-admin-action-confirm="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(212,165,32,0.62);
            background:linear-gradient(180deg, rgba(244,201,91,0.98) 0%, rgba(201,143,19,0.98) 100%);
            border-radius:10px;color:#080808;font-size:14px;font-weight:900;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.7' : '1'};
          ">${busy ? 'Изчакай…' : escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    </div>
  `
}

export function renderChatAdminActionToast(state: LobbyScreenState): string {
  const toast = state.chatAdminActionToast
  if (!toast) return ''

  return `
    <div style="
      position:fixed;inset:0;z-index:9700;
      display:flex;align-items:flex-end;justify-content:center;
      padding-bottom:64px;
      pointer-events:none;
    ">
      <div style="
        pointer-events:auto;
        background:#1a1a2e;
        border:1px solid ${toast.ok ? 'rgba(212,165,32,0.55)' : 'rgba(239,68,68,0.55)'};
        border-radius:12px;
        padding:14px 22px;
        text-align:center;
        box-shadow:0 8px 40px rgba(0,0,0,0.7);
        max-width:calc(100vw - 48px);
        animation:prInfoIn 0.18s ease both;
      ">
        <div style="font-size:14px;font-weight:800;color:${toast.ok ? '#fde68a' : '#fca5a5'};">${escapeHtml(toast.text)}</div>
      </div>
    </div>
  `
}

export function renderPikaTeamActionConfirmPopup(state: LobbyScreenState): string {
  const pending = state.pikaTeamActionConfirm
  if (!pending) return ''

  const isGrant = pending.action === 'grant'
  const title = isGrant ? 'Направи Екип Pika.bg?' : 'Премахни Екип Pika.bg?'
  const baseMessage = isGrant
    ? 'Потребителят ще може да вижда X и да трие съобщения от общия чат в лобито. Няма да получи достъп до админ панела, Сървър, потребители, плащания или турнири.'
    : 'Потребителят ще загуби правото да трие съобщения от общия чат в лобито.'
  const previousLabel = pending.previousRole === 'subadmin'
    ? 'Субадмин'
    : pending.previousRole === 'chat_admin'
      ? 'Чат админ'
      : null
  const message = isGrant && previousLabel
    ? `${baseMessage} Текущата роля „${previousLabel}“ ще бъде заменена.`
    : baseMessage
  const confirmLabel = isGrant ? 'Направи Екип Pika.bg' : 'Премахни'
  const busy = state.pikaTeamActionBusy

  return `
    <div style="
      position:fixed;inset:0;z-index:9600;
      display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.7);
    ">
      <div style="
        background:#1a1a2e;border:1px solid rgba(212,165,32,0.35);
        border-radius:16px;padding:28px 28px 24px;max-width:400px;width:90%;
        box-shadow:0 20px 60px rgba(0,0,0,0.6);
      ">
        <div style="font-size:18px;font-weight:900;color:#fff;margin-bottom:14px;">${escapeHtml(title)}</div>
        <div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.5;margin-bottom:24px;">${escapeHtml(message)}</div>
        <div style="display:flex;gap:12px;">
          <button type="button" data-pika-team-action-cancel="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);
            border-radius:10px;color:rgba(255,255,255,0.7);font-size:14px;font-weight:700;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.6' : '1'};
          ">Отказ</button>
          <button type="button" data-pika-team-action-confirm="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(244,114,182,0.62);
            background:linear-gradient(180deg, rgba(251,182,219,0.98) 0%, rgba(244,114,182,0.98) 100%);
            border-radius:10px;color:#080808;font-size:14px;font-weight:900;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.7' : '1'};
          ">${busy ? 'Изчакай…' : escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    </div>
  `
}

export function renderPikaTeamActionToast(state: LobbyScreenState): string {
  const toast = state.pikaTeamActionToast
  if (!toast) return ''

  return `
    <div style="
      position:fixed;inset:0;z-index:9700;
      display:flex;align-items:flex-end;justify-content:center;
      padding-bottom:64px;
      pointer-events:none;
    ">
      <div style="
        pointer-events:auto;
        background:#1a1a2e;
        border:1px solid ${toast.ok ? 'rgba(244,114,182,0.55)' : 'rgba(239,68,68,0.55)'};
        border-radius:12px;
        padding:14px 22px;
        text-align:center;
        box-shadow:0 8px 40px rgba(0,0,0,0.7);
        max-width:calc(100vw - 48px);
        animation:prInfoIn 0.18s ease both;
      ">
        <div style="font-size:14px;font-weight:800;color:${toast.ok ? '#f9a8d4' : '#fca5a5'};">${escapeHtml(toast.text)}</div>
      </div>
    </div>
  `
}

export function renderTopChatAdminActionConfirmPopup(state: LobbyScreenState): string {
  const pending = state.topChatAdminActionConfirm
  if (!pending) return ''

  const isGrant = pending.action === 'grant'
  const title = isGrant ? 'Направи TOP чат админ?' : 'Премахни TOP чат админ?'
  const baseMessage = isGrant
    ? 'Потребителят ще може да вижда X и да трие съобщения от общия чат в лобито. Няма да получи достъп до админ панела, Сървър, потребители, плащания, турнири или други административни права.'
    : 'Потребителят ще загуби правото да трие съобщения от общия чат в лобито.'
  const previousLabel = pending.previousRole === 'subadmin'
    ? 'Субадмин'
    : pending.previousRole === 'chat_admin'
      ? 'Чат админ'
      : pending.previousRole === 'pika_team'
        ? 'Екип Pika.bg'
        : null
  const message = isGrant && previousLabel
    ? `${baseMessage} Текущата роля „${previousLabel}“ ще бъде заменена.`
    : baseMessage
  const confirmLabel = isGrant ? 'Направи TOP чат админ' : 'Премахни'
  const busy = state.topChatAdminActionBusy

  return `
    <div style="
      position:fixed;inset:0;z-index:9600;
      display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.7);
    ">
      <div style="
        background:#1a1a2e;border:1px solid rgba(192,132,252,0.42);
        border-radius:16px;padding:28px 28px 24px;max-width:400px;width:90%;
        box-shadow:0 20px 60px rgba(0,0,0,0.6);
      ">
        <div style="font-size:18px;font-weight:900;color:#fff;margin-bottom:14px;">${escapeHtml(title)}</div>
        <div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.5;margin-bottom:24px;">${escapeHtml(message)}</div>
        <div style="display:flex;gap:12px;">
          <button type="button" data-top-chat-admin-action-cancel="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);
            border-radius:10px;color:rgba(255,255,255,0.7);font-size:14px;font-weight:700;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.6' : '1'};
          ">Отказ</button>
          <button type="button" data-top-chat-admin-action-confirm="1" ${busy ? 'disabled' : ''} style="
            flex:1;padding:11px;border:1px solid rgba(192,132,252,0.68);
            background:linear-gradient(180deg, rgba(216,180,254,0.98) 0%, rgba(192,132,252,0.98) 100%);
            border-radius:10px;color:#080808;font-size:14px;font-weight:900;
            cursor:${busy ? 'default' : 'pointer'};opacity:${busy ? '0.7' : '1'};
          ">${busy ? 'Изчакай...' : escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    </div>
  `
}

export function renderTopChatAdminActionToast(state: LobbyScreenState): string {
  const toast = state.topChatAdminActionToast
  if (!toast) return ''

  return `
    <div style="
      position:fixed;inset:0;z-index:9700;
      display:flex;align-items:flex-end;justify-content:center;
      padding-bottom:64px;
      pointer-events:none;
    ">
      <div style="
        pointer-events:auto;
        background:#1a1a2e;
        border:1px solid ${toast.ok ? 'rgba(192,132,252,0.58)' : 'rgba(239,68,68,0.55)'};
        border-radius:12px;
        padding:14px 22px;
        text-align:center;
        box-shadow:0 8px 40px rgba(0,0,0,0.7);
        max-width:calc(100vw - 48px);
        animation:prInfoIn 0.18s ease both;
      ">
        <div style="font-size:14px;font-weight:800;color:${toast.ok ? '#d8b4fe' : '#fca5a5'};">${escapeHtml(toast.text)}</div>
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

function renderProfileAccessBlockPopup(state: LobbyScreenState): string {
  const popup = state.profileAccessBlockPopup
  if (popup === null) return ''

  const viewerIsBlocker = popup.code === 'profile_blocked_by_viewer'
  const message = viewerIsBlocker
    ? 'Вие сте блокирали този потребител.'
    : 'Този потребител ви е блокирал.'

  return `
    <div data-profile-access-block-popup-root="1" style="position:fixed;inset:0;z-index:13600;display:flex;align-items:center;justify-content:center;padding:24px;">
      <button type="button" data-profile-access-block-close="1" aria-label="Затвори" style="position:absolute;inset:0;border:0;background:rgba(0,0,0,0.76);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);cursor:pointer;"></button>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,430px);border-radius:8px;background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);border:1px solid rgba(212,165,32,0.50);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:26px 22px;text-align:center;display:grid;gap:18px;">
        <div style="font-size:17px;font-weight:900;color:#f8fafc;line-height:1.45;">${escapeHtml(message)}</div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
          ${viewerIsBlocker ? `<button type="button" data-profile-access-block-unblock="${escapeHtml(popup.profileId)}" style="min-height:40px;padding:0 18px;border:1px solid rgba(212,165,32,0.55);border-radius:8px;background:linear-gradient(180deg,rgba(244,201,91,0.96) 0%,rgba(201,143,19,0.96) 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;">Отблокирай</button>` : ''}
          <button type="button" data-profile-access-block-close="1" style="min-height:40px;padding:0 18px;border:1px solid rgba(255,255,255,0.18);border-radius:8px;background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.86);font-size:13px;font-weight:900;cursor:pointer;">Затвори</button>
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

// Тесен callback subset за per-message wiring — targeted append пътя
// (appendTopicMessageNode в createLobbyFlowController.ts) не build-ва
// целия масивен RenderLobbyScreenOptions обект (скъпо, дублиращо build
// логиката на renderLobby()), само тия конкретни callback-и, all от които
// вече delegират 1:1 на съществуващи controller функции.
export type TopicMessageNodeCallbacks = Pick<
  RenderLobbyScreenOptions,
  | 'onTopicMessageAuthorClick'
  | 'onTopicMessagePersonalClick'
  | 'onTopicMessageLikeToggleClick'
  | 'onTopicReplyClick'
  | 'onTopicThreadOpen'
  | 'onTopicMuteClick'
  | 'onTopicMessageDeleteClick'
  | 'onTopicMessageEditClick'
  | 'onTopicMessageEditSubmit'
  | 'onTopicMessageEditInput'
  | 'onTopicMessageEditCancel'
  | 'onTopicsInfoToast'
>

// Reusable per-message event wiring — извиква се както от пълния render цикъл
// (веднъж за всеки [data-topic-message] node в root, виж loop-а по-долу в
// renderLobbyScreen), така и от targeted single-node append пътя (виж
// appendTopicMessageNode в createLobbyFlowController.ts), за да не се дублира
// wiring логиката на две места. querySelectorAll-ите тук са scope-нати ВЪТРЕ
// в messageNode, не в целия root — с targeted append не искаме да re-wire-ваме
// вече-mounted nodes (double-listener risk), само новия node.
function wireTopicMessageNode(
  root: HTMLElement,
  state: LobbyScreenState,
  options: TopicMessageNodeCallbacks,
  messageNode: HTMLElement,
): void {
  messageNode.querySelectorAll<HTMLButtonElement>('[data-topic-message-author]').forEach((button) => {
    button.addEventListener('click', () => {
      const profileId = button.dataset.topicMessageAuthor ?? ''
      const displayName = button.dataset.topicMessageAuthorName ?? ''
      if (profileId) options.onTopicMessageAuthorClick(profileId, displayName)
    })
  })

  messageNode.querySelectorAll<HTMLButtonElement>('[data-topic-message-personal]').forEach((button) => {
    button.addEventListener('click', () => {
      const profileId = button.dataset.topicMessagePersonal ?? ''
      const displayName = button.dataset.topicMessagePersonalName ?? ''
      if (profileId) options.onTopicMessagePersonalClick(profileId, displayName)
    })
  })

  messageNode.querySelectorAll<HTMLButtonElement>('[data-topic-message-like]').forEach((btn) => {
    const messageId = btn.dataset.topicMessageLike ?? ''
    if (!messageId) return
    btn.addEventListener('click', () => {
      options.onTopicMessageLikeToggleClick(messageId)
    })
  })

  messageNode.querySelectorAll<HTMLButtonElement>('[data-topic-message-reply]').forEach((btn) => {
    const rootMessageId = btn.dataset.topicMessageReply ?? ''
    if (!rootMessageId) return
    btn.addEventListener('click', () => {
      const anchorEl = root.querySelector<HTMLElement>(`[data-topic-message="${cssEscape(rootMessageId)}"]`)
      const scrollAnchor = anchorEl
        ? { messageId: rootMessageId, top: anchorEl.getBoundingClientRect().top }
        : null
      options.onTopicReplyClick(rootMessageId, scrollAnchor)
    })
  })

  const topicCardInteractiveSelector = [
    'button',
    'a',
    'input',
    'textarea',
    'select',
    'label',
    '[data-image-viewer-open="1"]',
  ].join(',')
  // FIX (self-match regression, виж git show d593ebc за pre-refactor
  // поведение): data-topic-card-open е атрибут на САМИЯ messageNode (root
  // card wrapper, виж renderTopicMessageRow: data-topic-message И
  // data-topic-card-open са на един и същ <div>), не descendant.
  // messageNode.querySelectorAll('[data-topic-card-open]') никога не матчва
  // self — стария код (пре-consolidation) търсеше от root.querySelectorAll,
  // където root е целия lobby container (не картата), значи descendant
  // match-ът работеше правилно там. Тук messageNode Е картата, затова explicit
  // self-check вместо querySelectorAll.
  const card = messageNode.hasAttribute('data-topic-card-open') ? messageNode : null
  if (card !== null) {
    const rootMessageId = card.dataset.topicCardOpen ?? ''
    if (rootMessageId) {
      const openCard = () => {
        const scrollAnchor = { messageId: rootMessageId, top: card.getBoundingClientRect().top }
        options.onTopicThreadOpen(rootMessageId, scrollAnchor)
      }
      card.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null
        if (target?.closest(topicCardInteractiveSelector)) {
          return
        }
        openCard()
      })
      card.addEventListener('keydown', (event) => {
        if (event.target !== card) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        openCard()
      })
    }
  }

  messageNode.querySelectorAll<HTMLButtonElement>('[data-topic-mute-toggle]').forEach((btn) => {
    const targetProfileId = btn.dataset.topicMuteToggle ?? ''
    const targetDisplayName = btn.dataset.topicMuteToggleName ?? ''
    const sourceMessageId = btn.dataset.topicMuteToggleMessageId || null
    const sourceKind = (btn.dataset.topicMuteToggleSourceKind as 'lafche_post' | 'topic_root' | 'topic_reply' | 'unspecified' | undefined) ?? 'unspecified'
    if (!targetProfileId) return
    btn.addEventListener('click', () => {
      const topicId = state.activeTopicId
      if (!topicId) return
      options.onTopicMuteClick(topicId, targetProfileId, targetDisplayName, sourceMessageId, sourceKind)
    })
  })

  messageNode.querySelectorAll<HTMLButtonElement>('[data-topic-message-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.topicMessageDeleteBlocked === '1') {
        const reason = btn.dataset.topicMessageDeleteDeniedReason?.trim() ?? ''
        btn.focus()
        btn.dataset.tooltipOpen = '1'
        if (reason.length > 0) options.onTopicsInfoToast(reason)
        window.setTimeout(() => {
          delete btn.dataset.tooltipOpen
        }, 1800)
        return
      }
      const messageId = btn.dataset.topicMessageDelete?.trim() ?? ''
      const isRoot = btn.dataset.topicMessageDeleteIsRoot === '1'
      const isModeratorAction = btn.dataset.topicMessageDeleteIsModeratorAction === '1'
      if (messageId.length > 0 && state.activeTopicId) {
        options.onTopicMessageDeleteClick(state.activeTopicId, messageId, isRoot, isModeratorAction)
      }
    })
  })

  messageNode.querySelectorAll<HTMLButtonElement>('[data-topic-message-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.topicMessageEditBlocked === '1') {
        const reason = btn.dataset.topicMessageEditDeniedReason?.trim() ?? ''
        btn.focus()
        btn.dataset.tooltipOpen = '1'
        if (reason.length > 0) options.onTopicsInfoToast(reason)
        window.setTimeout(() => {
          delete btn.dataset.tooltipOpen
        }, 1800)
        return
      }
      const messageId = btn.dataset.topicMessageEdit?.trim() ?? ''
      if (messageId.length > 0 && state.activeTopicId) {
        options.onTopicMessageEditClick(state.activeTopicId, messageId)
      }
    })
  })

  messageNode.querySelectorAll<HTMLFormElement>('[data-topic-message-edit-form]').forEach((form) => {
    const messageId = form.dataset.topicMessageEditForm ?? ''
    if (!messageId) return
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      options.onTopicMessageEditSubmit(messageId)
    })
  })

  messageNode.querySelectorAll<HTMLTextAreaElement>('[data-topic-message-edit-text]').forEach((textarea) => {
    const messageId = textarea.dataset.topicMessageEditText ?? ''
    if (!messageId) return
    textarea.addEventListener('input', (event) => {
      options.onTopicMessageEditInput(messageId, (event.currentTarget as HTMLTextAreaElement).value)
    })
  })

  messageNode.querySelectorAll<HTMLButtonElement>('[data-topic-message-edit-cancel]').forEach((btn) => {
    const messageId = btn.dataset.topicMessageEditCancel ?? ''
    if (!messageId) return
    btn.addEventListener('click', () => {
      options.onTopicMessageEditCancel(messageId)
    })
  })
}

/**
 * Targeted patch за Topics/Lafche/mobile-menu unread badge-ове
 * (topic_unread_count_changed / topic_seen_updated / thread variants push) —
 * update-ва САМО textContent на вече-mounted badge <span> nodes, без да
 * пипа родителския DOM (mobile menu <details> subtree остава напълно
 * непокътнат, production flicker fix — виж call site в
 * createLobbyFlowController.ts).
 *
 * Badge-овете се рендират conditionally (span присъства само при count > 0,
 * виж generalUnreadBadge/lafcheHasUnread/mobileMenuBadge в
 * renderTopicsScreen.ts/renderLobbyScreen.ts) — structural presence/absence
 * промяна (0→>0 create, >0→0 remove) НЕ е безопасна за in-place text patch,
 * затова връща false в тези случаи и caller-ът трябва да fallback-не към
 * scheduleRender()/render().
 *
 * Връща true само ако ВСИЧКИ badge-и, засегнати от тази промяна, са могли
 * да се patch-нат in-place (presence непроменено, само число/text различно).
 */
export function refreshTopicsUnreadDom(root: HTMLElement, state: LobbyScreenState): boolean {
  let allPatchedSafely = true

  // data-topics-general-badge и data-topics-lafche-badge са PERSISTENT nodes
  // вече (Вариант A — display:none/inline-flex toggle, mirror на
  // established data-mobile-menu-total-badge pattern по-долу) — само видими
  // докато state.view === 'topics' (renderTopicsScreen mount), затова
  // липсата им на друг екран е ОЧАКВАНА (viewNotTopics), не structural
  // fallback trigger. Presence/absence на самия badge (0↔>0 count) вече не е
  // structural промяна — display+textContent patch достатъчен.
  const isOnTopicsScreen = root.querySelector('[data-topics-screen="1"]') !== null

  const generalUnreadTotal = getTopicsMessagesUnreadRaw(state)
  const generalBadgeText = formatTopicUnreadBadgeCount(generalUnreadTotal)
  const generalBadgeEl = root.querySelector<HTMLElement>('[data-topics-general-badge="1"]')
  if (generalBadgeEl !== null) {
    generalBadgeEl.style.display = generalBadgeText !== null ? 'inline-flex' : 'none'
    generalBadgeEl.textContent = generalBadgeText ?? ''
  } else if (isOnTopicsScreen) {
    allPatchedSafely = false
  }

  const lafcheHasUnread = getLafcheUnreadContribution(state) > 0
  const lafcheBadgeEl = root.querySelector<HTMLElement>('[data-topics-lafche-badge="1"]')
  if (lafcheBadgeEl !== null) {
    lafcheBadgeEl.style.display = lafcheHasUnread ? 'inline-block' : 'none'
  } else if (isOnTopicsScreen) {
    allPatchedSafely = false
  }

  // data-mobile-menu-total-badge е PERSISTENT node (винаги в DOM, display:
  // none/flex toggle — mirror на established data-support-unread-badge
  // desktop pattern, виж renderMobileMenu) — presence/absence НЕ е structural
  // промяна тук, само display+textContent patch (за разлика от general/lafche
  // badge-овете по-горе, чиито node-ове остават conditionally rendered).
  const mobileMenuBadgeCount = getMobileMenuNotificationRaw(state)
  const mobileMenuBadgeText = formatNotificationBadgeCount(mobileMenuBadgeCount)
  const mobileMenuBadgeEl = root.querySelector<HTMLElement>('[data-mobile-menu-total-badge="1"]')
  if (mobileMenuBadgeEl !== null) {
    mobileMenuBadgeEl.style.display = mobileMenuBadgeText !== null ? 'flex' : 'none'
    mobileMenuBadgeEl.textContent = mobileMenuBadgeText ?? ''
  } else {
    allPatchedSafely = false
  }

  // Per-item badges вътре в menu panel-a (data-mobile-menu-item-badge="${icon}",
  // виж mobileMenuSvgItemContent) — PERSISTENT nodes, `display:inline-flex`
  // ПОСТОЯННО (запазено layout място в button row-a), само `visibility`
  // toggle-ва между hidden/visible. Fix за residual 0→1 flicker: старият
  // display:none↔inline-flex toggle вкарваше/махаше node-а от flex layout-a
  // (margin-left:auto in-flow item), причинявайки видим reflow на button
  // реда. visibility:hidden/visible пази node-а винаги in-flow (нулев layout
  // shift), само repaint на самия badge — mirror на generic markup pattern-a
  // за topics/support/chat/friends едновременно (един и същ template).
  // data-mobile-menu-total-badge (по-горе) НЕ се пипа тук — той е
  // position:absolute, вече без reflow проблем, различна geometry семантика.
  const supportItemBadgeText = formatNotificationBadgeCount(getSupportUnreadRaw(state))
  const supportItemBadgeEl = root.querySelector<HTMLElement>('[data-mobile-menu-item-badge="support"]')
  if (supportItemBadgeEl !== null) {
    supportItemBadgeEl.style.visibility = supportItemBadgeText !== null ? 'visible' : 'hidden'
    supportItemBadgeEl.textContent = supportItemBadgeText ?? ''
  } else {
    allPatchedSafely = false
  }

  // Per-item "Теми" badge — reuse-ва ТОЧНО getTopicsTotalUnreadRaw() — СЪЩИЯТ
  // derived source като markup-a при пълен render (mobileMenuSvgItemContent(
  // 'topics', 'Теми', topicsUnreadCount) в renderMobileMenu) — не собствена
  // формула (брифа §8).
  const topicsItemBadgeText = formatNotificationBadgeCount(getTopicsTotalUnreadRaw(state))
  const topicsItemBadgeEl = root.querySelector<HTMLElement>('[data-mobile-menu-item-badge="topics"]')
  if (topicsItemBadgeEl !== null) {
    topicsItemBadgeEl.style.visibility = topicsItemBadgeText !== null ? 'visible' : 'hidden'
    topicsItemBadgeEl.textContent = topicsItemBadgeText ?? ''
  } else {
    allPatchedSafely = false
  }

  // Per-thread unread badge (само отваряния thread card в directory list-а) —
  // patch-ва всички съществуващи thread badge nodes с текущата стойност от
  // state.topicMessages; ако конкретен root message няма ВЕЧЕ badge node
  // (defense-in-depth за списъци с много нишки), fallback се налага.
  const threadMessages = state.topicMessages ?? []
  for (const message of threadMessages) {
    const badgeText = formatTopicUnreadBadgeCount(message.unreadCount)
    const badgeEl = root.querySelector<HTMLElement>(`[data-topic-thread-unread-badge="${cssEscape(message.messageId)}"]`)
    if ((badgeEl !== null) !== (badgeText !== null)) {
      allPatchedSafely = false
      continue
    }
    if (badgeEl !== null && badgeText !== null) {
      badgeEl.textContent = badgeText
    }
  }

  return allPatchedSafely
}

/**
 * Targeted single-node append за нов Topics/Lafche съобщение (topic_message
 * push) — reuse-ва СЪЩИТЕ renderTopicMessageRow/renderLafcheMessageRow
 * markup builders като пълния render (виж renderTopicMessageStream), но
 * вмъква само ЕДИН нов DOM node в съществуващия [data-topic-messages-list]
 * container, вместо root.innerHTML replace на целия lobby subtree. Пази
 * identity на scroll container-а и на всички вече-mounted post nodes
 * (production flicker fix — виж call site в createLobbyFlowController.ts).
 *
 * Връща true при успешен targeted append; false ако DOM structure-ата не
 * съвпада с очакваното (напр. containers липсват, view не е активната тема) —
 * caller-ът трябва да fallback-не към пълен render() в този случай.
 */
export function appendTopicMessageNode(
  root: HTMLElement,
  state: LobbyScreenState,
  options: TopicMessageNodeCallbacks,
  message: TopicMessageSnapshot,
): boolean {
  if (state.view !== 'topics' || state.topicsMode !== 'topics') return false
  if (state.activeTopicId === null || state.activeTopicId !== message.topicId) return false

  const listEl = root.querySelector<HTMLElement>('[data-topic-messages-list="1"]')
  const scrollEl = root.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
  if (!listEl || !scrollEl) return false

  // Node вече присъства (напр. own-message ack race, дублиран push) —
  // третираме като success (нищо да append-ваме), не fallback.
  if (listEl.querySelector(`[data-topic-message="${cssEscape(message.messageId)}"]`)) {
    return true
  }

  const isLafche = state.activeTopicId === LAFCHE_TOPIC_ID
  const html = isLafche ? renderLafcheMessageRow(state, message) : renderTopicMessageRow(state, message)

  const template = document.createElement('template')
  template.innerHTML = html.trim()
  const newNode = template.content.firstElementChild as HTMLElement | null
  if (!newNode) return false

  // Lafche е chat-style (newest-at-bottom, DOM append) — General е card-feed
  // (newest-at-top, DOM prepend). Mirror-ва exact реда, който пълният
  // renderTopicMessageStream произвежда (виж isLafche reverse().map там).
  if (isLafche) {
    listEl.appendChild(newNode)
  } else {
    listEl.insertBefore(newNode, listEl.firstElementChild)
  }

  wireTopicMessageNode(root, state, options, newNode)

  // Scroll semantics — reuse established near-bottom (Lafche) / near-top
  // (General) thresholds, огледално на renderLobbyScreen-овата
  // wasLafcheNearBottom/wasTopicMessagesNearTop логика: местим scroll САМО
  // ако потребителят вече е бил close до "новото съдържание" края, никога
  // насила при четене другаде.
  const topicMessagesNearBottomThresholdPx = 96
  if (isLafche) {
    const distanceFromBottomBeforeAppend = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight - newNode.offsetHeight
    if (distanceFromBottomBeforeAppend <= topicMessagesNearBottomThresholdPx) {
      scrollEl.scrollTop = scrollEl.scrollHeight
    }
  }
  // General card-feed prepend не мести scroll позицията изобщо (established
  // семантика — нов root card се появява горе, без auto-scroll).

  return true
}

/**
 * Targeted patch за like button на конкретно съобщение (topic_message_like_
 * changed / _changed_self / _error push) — reuse-ва renderTopicLikeButton
 * (СЪЩИЯТ markup builder като пълния render) за outerHTML replace САМО на
 * бутона (не целия message node, камо ли root), после re-wire-ва click
 * listener-а (outerHTML replace унищожава стария node). Пази identity на
 * заграждащия message/reply node и на scroll container-а.
 *
 * Връща true при успешен patch; false ако node-ът не е намерен (message
 * вече не е mounted — thread switch race и подобни) — caller-ът трябва да
 * fallback-не към render()/scheduleRender().
 */
export function refreshTopicMessageLikeDom(
  root: HTMLElement,
  state: LobbyScreenState,
  options: Pick<TopicMessageNodeCallbacks, 'onTopicMessageLikeToggleClick'>,
  messageId: string,
  likeCount: number,
  viewerHasLiked: boolean,
): boolean {
  const existingBtn = root.querySelector<HTMLButtonElement>(`[data-topic-message-like="${cssEscape(messageId)}"]`)
  if (!existingBtn) return false

  const html = renderTopicLikeButton(state, messageId, likeCount, viewerHasLiked)
  const template = document.createElement('template')
  template.innerHTML = html.trim()
  const newBtn = template.content.firstElementChild as HTMLButtonElement | null
  if (!newBtn) return false

  existingBtn.replaceWith(newBtn)
  newBtn.addEventListener('click', () => {
    options.onTopicMessageLikeToggleClick(messageId)
  })

  return true
}

/**
 * Targeted patch за редактирано съобщение/reply (topic_message_edited push) —
 * outerHTML replace САМО на конкретния [data-topic-message]/[data-topic-reply]
 * node (reuse-ва renderTopicMessageRow/renderLafcheMessageRow/
 * renderTopicReplyRow, СЪЩИТЕ markup builders като пълния render), после
 * re-wire-ва listeners-ите на новия node (wireTopicMessageNode) — outerHTML
 * replace унищожава старите listeners. Пази identity на всички ДРУГИ nodes
 * и на scroll container-а.
 *
 * Връща true при успешен patch; false ако node/message snapshot не е
 * намерен — caller-ът трябва да fallback-не към render().
 */
export function refreshTopicMessageContentDom(
  root: HTMLElement,
  state: LobbyScreenState,
  options: TopicMessageNodeCallbacks,
  messageId: string,
  parentMessageId: string | null,
): boolean {
  if (parentMessageId === null) {
    const message = (state.topicMessages ?? []).find((m) => m.messageId === messageId)
    if (!message) return false
    const existingNode = root.querySelector<HTMLElement>(`[data-topic-message="${cssEscape(messageId)}"]`)
    if (!existingNode) return false

    const isLafche = state.activeTopicId === LAFCHE_TOPIC_ID
    const html = isLafche ? renderLafcheMessageRow(state, message) : renderTopicMessageRow(state, message)
    const template = document.createElement('template')
    template.innerHTML = html.trim()
    const newNode = template.content.firstElementChild as HTMLElement | null
    if (!newNode) return false

    existingNode.replaceWith(newNode)
    wireTopicMessageNode(root, state, options, newNode)
    return true
  }

  const replies = state.topicRepliesByRootId[parentMessageId]
  const reply = replies?.find((r) => r.messageId === messageId)
  if (!reply) return false
  const existingNode = root.querySelector<HTMLElement>(`[data-topic-reply="${cssEscape(messageId)}"]`)
  if (!existingNode) return false

  const html = renderTopicReplyRow(state, reply)
  const template = document.createElement('template')
  template.innerHTML = html.trim()
  const newNode = template.content.firstElementChild as HTMLElement | null
  if (!newNode) return false

  existingNode.replaceWith(newNode)
  wireTopicMessageNode(root, state, options, newNode)
  return true
}

/**
 * Targeted patch за изтрито съобщение/reply (topic_message_deleted push) —
 * премахва САМО конкретния DOM node (element.remove()), вместо пълен
 * innerHTML remount. Пази identity на всички останали nodes и на scroll
 * container-а.
 *
 * Връща true при успешен removal; false ако node-ът не е намерен —
 * caller-ът трябва да fallback-не към render() (напр. root delete с replies
 * cleanup / thread-mode navigation промени, покрити от structural fallback).
 */
export function removeTopicMessageDom(
  root: HTMLElement,
  messageId: string,
  parentMessageId: string | null,
): boolean {
  const selector = parentMessageId === null
    ? `[data-topic-message="${cssEscape(messageId)}"]`
    : `[data-topic-reply="${cssEscape(messageId)}"]`
  const existingNode = root.querySelector<HTMLElement>(selector)
  if (!existingNode) return false
  existingNode.remove()
  return true
}

export function renderLobbyScreen(
  root: HTMLElement,
  options: RenderLobbyScreenOptions,
): void {
  _renderLobbyScreenCallCount += 1
  const { state } = options
  const canStartSearch = state.isConnected && !state.isSearching
  const isPhoneLayout = isPhoneLayoutViewport()
  const mobileLayoutAttribute = isPhoneLayout ? 'data-mobile-layout="1"' : ''
  const privateRoomsCount = getPrivateRoomsBadgeCount(state.privateRooms)
  const profileName = state.displayName.trim() || 'Играч'
  const shouldShowLobbyChatFullscreen = isPhoneLayout && state.view === 'tables' && state.lobbyChatFullscreen
  if (!shouldShowLobbyChatFullscreen && state.lobbyChatFullscreen) {
    state.lobbyChatFullscreen = false
  }
  setLobbyChatBodyScrollLocked(shouldShowLobbyChatFullscreen)
  const topicMessagesNearBottomThresholdPx = 96

  // Prepend-safe scroll preservation за "Теми" message stream (т.4/7 от Етап 1
  // брифа): при зареждане на по-стари съобщения над текущите, потребителят не
  // трябва визуално да "подскочи". За разлика от savedLobbyChatScrollTop
  // по-долу (append в дъното → пазим абсолютен scrollTop), тук пазим
  // (scrollHeight - scrollTop) — разстоянието от ДОЛНИЯ край на текущото
  // съдържание, което остава константно дори когато нов, по-висок контент
  // бъде добавен НАД видимата зона. След re-render изваждаме тази стойност
  // от новата scrollHeight, за да получим правилния нов scrollTop.
  const prevTopicMessagesScrollEl = root.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
  const savedTopicMessagesDistanceFromBottom = prevTopicMessagesScrollEl
    ? prevTopicMessagesScrollEl.scrollHeight - prevTopicMessagesScrollEl.scrollTop
    : null
  // 'live-append'/'reconnect-refresh' клон (Етап 2) — огледално на
  // wasLobbyChatNearBottom по-долу: ново live съобщение дърпа до дъното
  // САМО ако потребителят вече е бил близо до него, иначе append без да го
  // "издърпаме" насила докато чете стари съобщения (Етап 2 брифа т.8).
  const wasTopicMessagesNearTop = prevTopicMessagesScrollEl === null
    ? true
    : prevTopicMessagesScrollEl.scrollTop <= topicMessagesNearBottomThresholdPx
  // "Лафче" reuse-ва СЪЩИЯ data-topic-messages-scroll container като General
  // (Вариант A — минимален diff), но иска обратна (chat-style, bottom-
  // anchored) семантика вместо General card-feed-a top-anchored семантика
  // (Лафче брифа §3: smart autoscroll до дъно само ако вече си бил близо).
  // Отделен near-BOTTOM snapshot тук, паралелно на near-TOP-a на General,
  // gate-нат по activeTopicId в write-back блока по-долу.
  const wasLafcheNearBottom = prevTopicMessagesScrollEl === null
    ? true
    : prevTopicMessagesScrollEl.scrollHeight - prevTopicMessagesScrollEl.scrollTop - prevTopicMessagesScrollEl.clientHeight <= topicMessagesNearBottomThresholdPx
  const savedTopicMessagesScrollTop = prevTopicMessagesScrollEl?.scrollTop ?? 0
  const explicitTopicMessagesScrollAnchor = state.topicMessagesScrollAnchor
  const stableTopicMessagesScrollAnchor = explicitTopicMessagesScrollAnchor ?? (() => {
    if (prevTopicMessagesScrollEl === null) return null
    const scrollRect = prevTopicMessagesScrollEl.getBoundingClientRect()
    const anchorEl = Array.from(prevTopicMessagesScrollEl.querySelectorAll<HTMLElement>('[data-topic-message]'))
      .find((el) => el.getBoundingClientRect().bottom >= scrollRect.top)
    return anchorEl
      ? { messageId: anchorEl.dataset.topicMessage ?? '', top: anchorEl.getBoundingClientRect().top }
      : null
  })()
  const prevTopicThreadScrollEl = root.querySelector<HTMLElement>('[data-topic-thread-scroll="1"]')
  const wasTopicThreadNearBottom = prevTopicThreadScrollEl === null
    ? true
    : prevTopicThreadScrollEl.scrollHeight - prevTopicThreadScrollEl.scrollTop - prevTopicThreadScrollEl.clientHeight <= topicMessagesNearBottomThresholdPx
  const savedTopicThreadScrollTop = prevTopicThreadScrollEl?.scrollTop ?? 0

  const prevTopicComposerTextEl = root.querySelector<HTMLTextAreaElement>('[data-topics-composer-text="1"]')
  const wasTopicComposerFocused = prevTopicComposerTextEl !== null && document.activeElement === prevTopicComposerTextEl
  const savedTopicComposerSelectionStart = wasTopicComposerFocused ? prevTopicComposerTextEl.selectionStart : null
  const savedTopicComposerSelectionEnd = wasTopicComposerFocused ? prevTopicComposerTextEl.selectionEnd : null

  // Thread reply composer-ът (за разлика от root "Общ" composer-a точно
  // над него) липсваше от focus/caret preservation-а — несвързан badge/
  // notification rerender докато потребителят пише отговор го обезфокусваше
  // (production UX hotfix). Пазим и rootId-a на формата (не само selector-a),
  // за да не върнем focus-а насила, ако между render-ите потребителят реално
  // е затворил/сменил thread-а (топлив state.topicReplyComposerOpenRootId).
  const prevTopicReplyComposerTextEl = root.querySelector<HTMLTextAreaElement>('[data-topics-reply-composer-text="1"]')
  const prevTopicReplyComposerFormEl = prevTopicReplyComposerTextEl?.closest<HTMLFormElement>('[data-topics-reply-composer-form="1"]') ?? null
  const savedTopicReplyComposerRootId = prevTopicReplyComposerFormEl?.dataset.topicsReplyComposerRootId ?? null
  const wasTopicReplyComposerFocused = prevTopicReplyComposerTextEl !== null && document.activeElement === prevTopicReplyComposerTextEl
  const savedTopicReplyComposerSelectionStart = wasTopicReplyComposerFocused ? prevTopicReplyComposerTextEl.selectionStart : null
  const savedTopicReplyComposerSelectionEnd = wasTopicReplyComposerFocused ? prevTopicReplyComposerTextEl.selectionEnd : null

  const savedScrollTop = root.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')?.scrollTop ?? 0
  // Отделно от savedScrollTop по-горе: списъкът с admin support запитвания има собствен
  // scroll контейнер, за да не се презаписва позицията му от detail изгледа на разговора
  // (двата дела на мобилния admin support екран споделят един и същ root, но не и една скрол зона).
  const currentAdminSupportMobileListEl = root.querySelector<HTMLElement>('[data-admin-support-mobile-list-scroll="1"]')
  if (currentAdminSupportMobileListEl) {
    savedAdminSupportMobileListScrollTop = currentAdminSupportMobileListEl.scrollTop
  }
  // stakesFirstCardIndex се пази като модулна променлива — не се чете от scrollLeft
  const prevSearchEl = root.querySelector<HTMLInputElement>('[data-lobby-players-search="1"]')
  const wasSearchFocused = prevSearchEl !== null && document.activeElement === prevSearchEl
  const savedSearchCaret = wasSearchFocused ? prevSearchEl.selectionStart : null

  // Личният чат се пренарежда изцяло (root.innerHTML) при всяко входящо съобщение,
  // periodic refresh или друго фоново обновяване — без това, недовършена чернова
  // в полето за писане би изчезвала под пръстите на потребителя.
  const prevChatInputEl = root.querySelector<HTMLInputElement>('[data-lobby-chat-message-input="1"]')
  const wasChatInputFocused = prevChatInputEl !== null && document.activeElement === prevChatInputEl
  const savedChatInputSelectionStart = wasChatInputFocused ? prevChatInputEl.selectionStart : null
  const savedChatInputSelectionEnd = wasChatInputFocused ? prevChatInputEl.selectionEnd : null
  const savedChatInputSelectionDirection = wasChatInputFocused ? prevChatInputEl.selectionDirection : null
  const prevChatMessagesScrollEl = root.querySelector<HTMLElement>('[data-chat-messages-scroll="1"]')
  const wasChatMessagesNearBottom = prevChatMessagesScrollEl === null
    ? true
    : prevChatMessagesScrollEl.scrollHeight - prevChatMessagesScrollEl.scrollTop - prevChatMessagesScrollEl.clientHeight < 48
  const savedChatMessagesScrollTop = prevChatMessagesScrollEl?.scrollTop ?? 0

  // Общ лайв чат в лобито — същия проблем/решение като личния чат по-горе:
  // всяко несвързано WS събитие пренарежда целия root, затова изрично пазим
  // draft/focus/caret на полето И scroll позицията на съобщенията. За разлика
  // от личния чат, тук съобщенията идват от ВСИЧКИ потребители непрекъснато,
  // затова "smart autoscroll" е задължителен: скролваме до дъно само ако
  // потребителят вече Е бил близо до дъното (или е неговото собствено ново
  // съобщение — това естествено съвпада, защото изпращане винаги става от
  // дъното) — иначе не му местим позицията, докато чете по-стари съобщения.
  const prevLobbyChatScrollEl = root.querySelector<HTMLElement>('[data-lobby-livechat-messages-scroll="1"]')
  const wasLobbyChatNearBottom = prevLobbyChatScrollEl === null
    ? true
    : prevLobbyChatScrollEl.scrollHeight - prevLobbyChatScrollEl.scrollTop - prevLobbyChatScrollEl.clientHeight < 48
  const savedLobbyChatScrollTop = prevLobbyChatScrollEl?.scrollTop ?? 0

  const prevLobbyChatInputEl = root.querySelector<HTMLInputElement>('[data-lobby-livechat-input="1"]')
  const wasLobbyChatInputFocused = prevLobbyChatInputEl !== null && document.activeElement === prevLobbyChatInputEl
  const savedLobbyChatInputSelectionStart = wasLobbyChatInputFocused ? prevLobbyChatInputEl.selectionStart : null
  const savedLobbyChatInputSelectionEnd = wasLobbyChatInputFocused ? prevLobbyChatInputEl.selectionEnd : null
  const savedLobbyChatInputSelectionDirection = wasLobbyChatInputFocused ? prevLobbyChatInputEl.selectionDirection : null

  const prevSupportInputEl = root.querySelector<HTMLTextAreaElement>('[data-support-send-form="1"] textarea[name="body"]')
  const wasSupportInputFocused = prevSupportInputEl !== null && document.activeElement === prevSupportInputEl
  const savedSupportInputValue = wasSupportInputFocused ? prevSupportInputEl.value : null
  const shouldRestoreSupportInputValue = savedSupportInputValue !== null && state.supportDraft === savedSupportInputValue
  const savedSupportInputSelectionStart = wasSupportInputFocused ? prevSupportInputEl.selectionStart : null
  const savedSupportInputSelectionEnd = wasSupportInputFocused ? prevSupportInputEl.selectionEnd : null
  const savedSupportInputSelectionDirection = wasSupportInputFocused ? prevSupportInputEl.selectionDirection : null
  const savedSupportInputScrollTop = wasSupportInputFocused ? prevSupportInputEl.scrollTop : 0
  const prevSupportMessagesScrollEl = root.querySelector<HTMLElement>('#support-popup-messages-scroll')
  const wasSupportMessagesNearBottom = prevSupportMessagesScrollEl === null
    ? true
    : prevSupportMessagesScrollEl.scrollHeight - prevSupportMessagesScrollEl.scrollTop - prevSupportMessagesScrollEl.clientHeight < 48
  const savedSupportMessagesScrollTop = prevSupportMessagesScrollEl?.scrollTop ?? 0

  const prevAdminSupportReplyEl = root.querySelector<HTMLTextAreaElement>('[data-admin-support-reply-form] textarea[name="body"]')
  const prevAdminSupportReplyFormEl = prevAdminSupportReplyEl?.closest<HTMLFormElement>('[data-admin-support-reply-form]') ?? null
  const savedAdminSupportReplyProfileId = prevAdminSupportReplyFormEl?.dataset.adminSupportReplyForm?.trim() ?? null
  const wasAdminSupportReplyFocused = prevAdminSupportReplyEl !== null && document.activeElement === prevAdminSupportReplyEl
  const savedAdminSupportReplyValue = wasAdminSupportReplyFocused ? prevAdminSupportReplyEl.value : null
  const shouldRestoreAdminSupportReplyValue = savedAdminSupportReplyValue !== null &&
    savedAdminSupportReplyProfileId !== null &&
    (state.adminSupportReplyDraftByProfileId[savedAdminSupportReplyProfileId] ?? '') === savedAdminSupportReplyValue
  const savedAdminSupportReplySelectionStart = wasAdminSupportReplyFocused ? prevAdminSupportReplyEl.selectionStart : null
  const savedAdminSupportReplySelectionEnd = wasAdminSupportReplyFocused ? prevAdminSupportReplyEl.selectionEnd : null
  const savedAdminSupportReplySelectionDirection = wasAdminSupportReplyFocused ? prevAdminSupportReplyEl.selectionDirection : null
  const savedAdminSupportReplyScrollTop = wasAdminSupportReplyFocused ? prevAdminSupportReplyEl.scrollTop : 0
  const prevAdminSupportMessagesScrollEl = root.querySelector<HTMLElement>('#support-admin-messages-scroll')
  const wasAdminSupportMessagesNearBottom = prevAdminSupportMessagesScrollEl === null
    ? true
    : prevAdminSupportMessagesScrollEl.scrollHeight - prevAdminSupportMessagesScrollEl.scrollTop - prevAdminSupportMessagesScrollEl.clientHeight < 48
  const savedAdminSupportMessagesScrollTop = prevAdminSupportMessagesScrollEl?.scrollTop ?? 0

  root.innerHTML = isPhoneLayout ? `
    <div
      ${mobileLayoutAttribute}
      data-lobby-screen-root="1"
      style="
        position:fixed;inset:0;
        background:#000000;color:#ffffff;
        font-family:Arial, Helvetica, sans-serif;
        ${state.view === 'topics'
          ? 'overflow:hidden;display:flex;flex-direction:column;'
          : 'overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;'}
        z-index:50;
      "
    >
      ${renderMobileMenu(state)}
      ${state.view === 'topics'
        ? `<div style="flex:1;min-height:0;display:flex;flex-direction:column;">${renderMobileLobbyScreenContent(state, profileName, canStartSearch)}</div>`
        : `${renderMobileLobbyScreenContent(state, profileName, canStartSearch)}${renderMobileFooter()}`}

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
      ${renderLobbyChatWriteLockedPopup(state)}
      ${renderGuestTrialPopup(state.guestTrialPopup)}
      ${renderGuestLockedStakePopup(state.guestLockedStakePopup)}
      ${renderLevelLockedStakePopup(state.levelLockedStakePopup)}
      ${renderShopPurchaseConfirmModal(state)}
      ${renderDailyRewardsPopup(state)}
      ${renderPrivateRoomInvitePopup(state)}
      ${renderPrivateRoomInviteFriendsPopup({
        isOpen: state.inviteFriendsPopupOpen,
        freeSeats: state.myPrivateRoom ? 4 - state.myPrivateRoom.slots.filter((s) => s.occupant !== null).length : 0,
        friends: state.inviteFriends,
      })}
      ${renderPrivateRoomInfoPopup(state)}
      ${renderPrivateRoomConflictPopup(state)}
      ${renderSubadminActionConfirmPopup(state)}
      ${renderAdminTopicReportsPanel(state)}
      ${renderSubadminActionToast(state)}
      ${renderChatAdminActionConfirmPopup(state)}
      ${renderChatAdminActionToast(state)}
      ${renderPikaTeamActionConfirmPopup(state)}
      ${renderPikaTeamActionToast(state)}
      ${renderTopChatAdminActionConfirmPopup(state)}
      ${renderTopChatAdminActionToast(state)}
      ${renderBlockedPlayersPopup(state)}
      ${renderBlockLimitPopup(state)}
      ${renderProfileAccessBlockPopup(state)}
      ${renderNoPlayersModal(state)}
      ${renderSupportPopup(state)}
      ${renderGuestContactPopup(state)}
    </div>
    ${renderGiftCoinsModal(state)}
    ${renderGiftSuccessModal(state)}
    ${renderGiftReceivedModal(state)}
    ${renderImageViewerOverlay(state)}
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
        ${state.view === 'topics'
          ? 'overflow:hidden;display:flex;flex-direction:column;'
          : 'overflow-y:auto;overflow-x:hidden;'}
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

      <div data-lobby-scale-stage="1" style="${state.view === 'topics'
        ? 'width:100%;height:100%;display:flex;flex-direction:column;min-height:0;'
        : `width:${PIKA_DESKTOP_CONTENT_MAX_WIDTH_PX}px; margin:0 auto; zoom:var(--lobby-scale);`}">
        ${renderNav(state)}

        <div
          ${state.view === 'topics' ? 'data-topics-desktop-shell="1"' : ''}
          style="${state.view === 'topics'
          ? `flex:1;min-height:0;display:flex;flex-direction:column;max-width:${PIKA_DESKTOP_CONTENT_MAX_WIDTH_PX}px;width:100%;margin:0 auto;padding:16px 20px;background:#000000;box-sizing:border-box;overflow:hidden;`
          : `max-width: ${PIKA_DESKTOP_CONTENT_MAX_WIDTH_PX}px; margin: 0 auto; padding: 16px 20px; background:#000000; box-sizing:border-box;`}">
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
                      isAdmin: state.isAdminOrSubadmin,
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
                      isAdmin: state.isAdminOrSubadmin,
                      loading: state.adminPaymentDetailLoading,
                      errorText: state.adminPaymentDetailErrorText,
                      purchase: state.adminPaymentDetailPurchase,
                    },
                    { onBack: () => {} },
                  )
              : state.view === 'admin-tournaments'
                ? renderAdminTournamentsPanel({
                    isAdminOrSubadmin: state.isAdminOrSubadmin,
                    canWrite: state.adminTournamentsCanWrite,
                    loading: state.adminTournamentsLoading,
                    errorText: state.adminTournamentsErrorText,
                    rows: state.adminTournamentsRows,
                    total: state.adminTournamentsTotal,
                    filters: state.adminTournamentsFilters,
                  })
              : state.view === 'admin-tournament-detail'
                ? renderAdminTournamentDetailPanel({
                    isAdminOrSubadmin: state.isAdminOrSubadmin,
                    canWrite: state.adminTournamentsCanWrite,
                    loading: state.adminTournamentDetailLoading,
                    errorText: state.adminTournamentDetailErrorText,
                    tournament: state.adminTournamentDetail,
                    actionBusy: state.adminTournamentActionBusy,
                    actionErrorText: state.adminTournamentActionErrorText,
                    actionInfoText: state.adminTournamentActionInfoText,
                    cancelConfirmOpen: state.adminTournamentCancelConfirmOpen,
                  })
            : state.view === 'tournaments'
              ? renderTournamentsScreen(state)
            : state.view === 'tournament-detail'
              ? renderTournamentDetailScreen(state)
            : state.view === 'tournament-how-it-works'
              ? renderTournamentHowItWorksPage(false)
            : state.view === 'topics'
              ? renderTopicsScreen(state)
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
                ? renderHeroSection(state, profileName, state.profile.avatarUrl, state.profile.yellowCoinsBalance, state.profile.wonGamesCount, state.profile.completedGamesCount, state.profile.rankTitle, state.profile.level, isPhoneLayout)
                : renderGuestHeroCard(state, state.signupBonusYellowCoins ?? 0, isPhoneLayout)}
              ${renderStakeSection(state.selectedStake, canStartSearch, state.isSearching, state.matchRooms, state.profile.level ?? 1, state.matchRoomsLoading, isPhoneLayout, state.profile.profileId === null)}
              ${renderBottomSection(
                state.lobbyPackages,
                state.profile.profileId !== null,
                state.dailyMissionsUnclaimedCount,
                getUnclaimedDailyRewardsBadgeCount(state) > 0,
                isPhoneLayout,
                privateRoomsCount,
              )}
            `}
          ${state.view === 'topics' ? '' : renderFooter()}
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
      ${renderLobbyChatWriteLockedPopup(state)}
      ${renderGuestTrialPopup(state.guestTrialPopup)}
      ${renderGuestLockedStakePopup(state.guestLockedStakePopup)}
      ${renderLevelLockedStakePopup(state.levelLockedStakePopup)}
      ${renderShopPurchaseConfirmModal(state)}
      ${renderDailyRewardsPopup(state)}
      ${renderPrivateRoomInvitePopup(state)}
      ${renderPrivateRoomInviteFriendsPopup({
        isOpen: state.inviteFriendsPopupOpen,
        freeSeats: state.myPrivateRoom ? 4 - state.myPrivateRoom.slots.filter((s) => s.occupant !== null).length : 0,
        friends: state.inviteFriends,
      })}
      ${renderPrivateRoomInfoPopup(state)}
      ${renderPrivateRoomConflictPopup(state)}
      ${renderSubadminActionConfirmPopup(state)}
      ${renderAdminTopicReportsPanel(state)}
      ${renderSubadminActionToast(state)}
      ${renderChatAdminActionConfirmPopup(state)}
      ${renderChatAdminActionToast(state)}
      ${renderPikaTeamActionConfirmPopup(state)}
      ${renderPikaTeamActionToast(state)}
      ${renderTopChatAdminActionConfirmPopup(state)}
      ${renderTopChatAdminActionToast(state)}
      ${renderBlockedPlayersPopup(state)}
      ${renderBlockLimitPopup(state)}
      ${renderProfileAccessBlockPopup(state)}
      ${renderNoPlayersModal(state)}
      ${renderSupportPopup(state)}
      ${renderGuestContactPopup(state)}
    </div>
    ${renderGiftCoinsModal(state)}
    ${renderGiftSuccessModal(state)}
    ${renderGiftReceivedModal(state)}
    ${renderImageViewerOverlay(state)}
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
    mobileMenuEntranceAnimationPending = false
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
    // Реално closed->open user action — маркира entrance анимацията за
    // изиграване на следващия mount/remount (виж renderMobileMenu()
    // consume-а по-горе), точно веднъж, дори remount-ът да дойде от
    // несвързан background render малко след клика.
    mobileMenuEntranceAnimationPending = true
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
      mobileMenuEntranceAnimationPending = false
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

  root.querySelectorAll<HTMLButtonElement>('[data-profile-access-block-close="1"]').forEach((btn) => {
    btn.addEventListener('click', options.onProfileAccessBlockClose)
  })

  root.querySelectorAll<HTMLButtonElement>('[data-profile-access-block-unblock]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const profileId = btn.dataset.profileAccessBlockUnblock?.trim() ?? ''
      if (profileId) options.onProfileAccessBlockUnblock(profileId)
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
    .querySelectorAll<HTMLElement>('[data-lobby-nav-tournaments="1"]')
    .forEach((element) => {
      element.addEventListener('click', (e) => {
        if (!shouldHandleSpaLinkClick(e as MouseEvent)) return
        e.preventDefault()
        options.onTournamentsClick()
      })
    })

  root
    .querySelectorAll<HTMLElement>('[data-lobby-nav-topics="1"]')
    .forEach((element) => {
      element.addEventListener('click', (e) => {
        if (!shouldHandleSpaLinkClick(e as MouseEvent)) return
        e.preventDefault()
        options.onTopicsClick()
      })
    })

  root
    .querySelector<HTMLButtonElement>('[data-topics-lafche-open="1"]')
    ?.addEventListener('click', options.onTopicsLafcheOpen)

  root
    .querySelector<HTMLButtonElement>('[data-topics-personal-open="1"]')
    ?.addEventListener('click', options.onTopicsPersonalOpen)

  root
    .querySelector<HTMLButtonElement>('[data-topics-personal-back="1"]')
    ?.addEventListener('click', options.onTopicsPersonalBack)

  root
    .querySelector<HTMLButtonElement>('[data-topics-personal-conversation-back="1"]')
    ?.addEventListener('click', options.onTopicsPersonalConversationBack)

  root.querySelectorAll<HTMLButtonElement>('[data-topics-back-to-general="1"]').forEach((button) => {
    button.addEventListener('click', () => {
      options.onTopicsBackToGeneral()
    })
  })

  // Per-message wiring (author/personal/like/reply/card-open/mute-toggle/
  // delete/edit) — консолидирано в wireTopicMessageNode (виж дефиницията ѝ
  // по-горе), извикано веднъж за всеки [data-topic-message] И [data-topic-reply]
  // node (replies reuse-ват СЪЩИТЕ data-topic-message-* child markers, само
  // wrapper-ът е data-topic-reply вместо data-topic-message — виж
  // renderTopicReplyRow), reuse-нато 1:1 и от targeted single-node append
  // пътя (appendTopicMessageNode) — без дублиране на wiring логиката.
  root.querySelectorAll<HTMLElement>('[data-topic-message], [data-topic-reply]').forEach((messageNode) => {
    wireTopicMessageNode(root, state, options, messageNode)
  })

  const topicMessagesScroll = root.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
  if (topicMessagesScroll) {
    topicMessagesScroll.addEventListener('scroll', () => {
      if (topicMessagesScroll.scrollHeight - topicMessagesScroll.scrollTop - topicMessagesScroll.clientHeight <= 40) {
        options.onTopicMessagesLoadOlder()
      }
    })
  }

  // ─── Composer (Етап 2) ───────────────────────────────────────────────────
  {
    const topicsComposerForm = root.querySelector<HTMLFormElement>('[data-topics-composer-form="1"]')
    const topicsComposerTextEl = root.querySelector<HTMLTextAreaElement>('[data-topics-composer-text="1"]')
    const topicsComposerSendBtn = root.querySelector<HTMLButtonElement>('[data-topics-composer-send="1"]')

    autoGrowTextarea(topicsComposerTextEl)

    if (topicsComposerForm) {
      const topicId = topicsComposerForm.dataset.topicsComposerTopicId ?? ''
      const isMuted = topicsComposerForm.dataset.topicsComposerMuteLocked === '1'
      const isVipLocked = topicsComposerForm.dataset.topicsComposerVipLocked === '1'

      topicsComposerForm.addEventListener('submit', (event) => {
        event.preventDefault()
        if (topicId) options.onTopicComposerSubmit(topicId)
      })

      if (isMuted || isVipLocked) {
        // Non-VIP/muted textarea — ДВА отделни handler-а с различна цел,
        // нарочно разделени (regression fix, втора итерация):
        //
        // 1) pointerdown: САМО preventDefault(), НИКАКВО popup тук. Focus (и
        //    оттам mobile keyboard) е browser-native default action на
        //    pointerdown/mousedown — preventDefault() тук е ЕДИНСТВЕНИЯТ
        //    начин да го спре навреме. Ако попадне на click вместо това,
        //    focus вече ще се е случил преди click-ът изобщо да стигне (click
        //    винаги идва СЛЕД mousedown/mouseup в native event order), значи
        //    твърде късно за preventDefault() да го отмени.
        // 2) click: отваря popup-а (mute — приоритет пред VIP, ако важат и
        //    двете; иначе VIP). Изчаква пълен press-release цикъл върху
        //    textarea-та, преди popup-ът изобщо да се появи — няма tap
        //    "остатък", който да падне върху вече отворения backdrop
        //    (position:fixed;inset:0) и да го затвори веднага (първата
        //    итерация на този fix направи точно тази грешка — отваряше
        //    popup-а на pointerdown, mirror на текущия send-бутон бъг).
        //
        // Резултат: readonly textarea никога не получава реален edit focus/
        // mobile keyboard (pointerdown продължава да го спира), а popup-ът
        // отваря се едва след завършен tap, без self-closing race. За mute:
        // popup-ът се отваря БЕЗ acknowledgement-dedup — всеки нов tap/click
        // отваря го отново, дори след предишно "Разбрах" (виж
        // onTopicComposerMutedTap/openTopicsSectionMutePopupForAttempt).
        topicsComposerTextEl?.addEventListener('pointerdown', (event) => {
          event.preventDefault()
        })
        topicsComposerTextEl?.addEventListener('click', (event) => {
          event.preventDefault()
          if (isMuted) options.onTopicComposerMutedTap()
          else options.onTopicComposerNonVipTap()
        })
        // Send бутонът няма focus/keyboard side effect за preempt-ване
        // (не е editable input) — само click е нужен, mirror на established
        // image-pick бутона по-долу.
        topicsComposerSendBtn?.addEventListener('click', (event) => {
          event.preventDefault()
          if (isMuted) options.onTopicComposerMutedTap()
          else options.onTopicComposerNonVipTap()
        })
      } else {
        submitTextareaOnEnter(topicsComposerTextEl)
        topicsComposerTextEl?.addEventListener('input', (event) => {
          const textarea = event.currentTarget as HTMLTextAreaElement
          if (topicId) options.onTopicComposerInput(topicId, textarea.value)
          autoGrowTextarea(textarea)
        })
        keepComposerFocusOnPointerSubmit(topicsComposerSendBtn)
      }

      // Image picker (Attachment feature) — non-VIP/muted клик отваря СЪЩИЯ
      // gate като текстовото поле, БЕЗ да отваря file picker преди проверка
      // (Attachment брифа т.3 — "server-side authorization е задължителен
      // security boundary", но UI-то също не трябва да покаже file picker-а).
      const imagePickBtn = root.querySelector<HTMLButtonElement>(`[data-topics-image-pick="${cssEscape(topicId)}"]`)
      const imageInput = root.querySelector<HTMLInputElement>(`[data-topics-image-input="${cssEscape(topicId)}"]`)
      const imageRemoveBtn = root.querySelector<HTMLButtonElement>(`[data-topics-image-remove="${cssEscape(topicId)}"]`)

      imagePickBtn?.addEventListener('click', () => {
        if (isMuted) {
          options.onTopicComposerMutedTap()
          return
        }
        if (isVipLocked) {
          options.onTopicComposerNonVipTap()
          return
        }
        imageInput?.click()
      })
      imageInput?.addEventListener('change', () => {
        const file = imageInput.files?.[0] ?? null
        imageInput.value = ''
        if (topicId && file !== null) {
          options.onTopicComposerImageSelect(topicId, file)
        }
      })
      imageRemoveBtn?.addEventListener('click', () => {
        if (topicId) options.onTopicComposerImageRemove(topicId)
      })
    }
  }

  // ─── VIP popup (Етап 2) ──────────────────────────────────────────────────
  {
    root.querySelector<HTMLElement>('[data-topics-vip-popup-backdrop="1"]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) options.onTopicsVipPopupClose()
    })
    root.querySelector<HTMLButtonElement>('[data-topics-vip-popup-close="1"]')?.addEventListener('click', () => {
      options.onTopicsVipPopupClose()
    })
    root.querySelector<HTMLButtonElement>('[data-topics-vip-popup-claim="1"]')?.addEventListener('click', () => {
      options.onTopicsVipPopupClaimLaunchGift()
    })
    root.querySelector<HTMLButtonElement>('[data-topics-vip-popup-see-plans="1"]')?.addEventListener('click', () => {
      options.onTopicsVipPopupSeePlans()
    })
  }

  // ─── Create Topic popup (Custom Topic Creation) ──────────────────────────
  {
    root.querySelector<HTMLElement>('[data-topic-create-backdrop="1"]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) options.onTopicCreatePopupClose()
    })
    root.querySelector<HTMLButtonElement>('[data-topic-create-close="1"]')?.addEventListener('click', () => {
      options.onTopicCreatePopupClose()
    })
    root.querySelector<HTMLButtonElement>('[data-topic-create-cancel="1"]')?.addEventListener('click', () => {
      options.onTopicCreatePopupClose()
    })
    root.querySelector<HTMLFormElement>('[data-topic-create-form="1"]')?.addEventListener('submit', (event) => {
      event.preventDefault()
      options.onTopicCreateSubmit()
    })
    const topicCreateTitleInput = root.querySelector<HTMLInputElement>('[data-topic-create-title-input="1"]')
    topicCreateTitleInput?.addEventListener('input', () => {
      options.onTopicCreateTitleInput(topicCreateTitleInput.value)
    })
    // Autofocus при отваряне — established UX за single-field popups (mirror
    // на established modal convention), само ако още не е фокусирано (избягва
    // caret jump/re-select при keystroke re-render).
    if (topicCreateTitleInput && document.activeElement !== topicCreateTitleInput) {
      topicCreateTitleInput.focus()
      const len = topicCreateTitleInput.value.length
      topicCreateTitleInput.setSelectionRange(len, len)
    }

    // Module-level singleton Esc listener (mirror на imageViewerEscListenerAttached
    // по-долу) — popup-ът re-render-ва на всеки keystroke, затова setup-ът
    // веднъж + свеж handler reference на всеки render е задължителен, за да
    // не се трупат дублирани document listeners.
    latestTopicCreateCloseHandler = state.topicCreatePopupOpen && !state.topicCreateBusy
      ? () => options.onTopicCreatePopupClose()
      : null
    if (!topicCreateEscListenerAttached) {
      topicCreateEscListenerAttached = true
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return
        latestTopicCreateCloseHandler?.()
      })
    }
  }

  // ─── Reusable in-app image viewer (lightbox) ─────────────────────────────
  // Delegated click за отваряне — снимките се render-ват в множество
  // message/reply rows (Topics + chat), delegation избягва N individual
  // listener-и при всеки re-render. Затваряне: X бутон, backdrop click, Esc
  // (desktop). History (system/PWA Back) е wire-нат отделно в
  // createLobbyFlowController.ts (popstate listener), не тук.
  {
    if (imageViewerRootListenerAttachedFor !== root) {
      imageViewerRootListenerAttachedFor = root
      root.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null
        const openTrigger = target?.closest<HTMLElement>('[data-image-viewer-open="1"]')
        if (openTrigger) {
          const viewUrl = openTrigger.dataset.imageViewerViewUrl ?? ''
          const downloadUrl = openTrigger.dataset.imageViewerDownloadUrl ?? ''
          if (viewUrl && downloadUrl) {
            latestImageViewerOpenHandler?.({ viewUrl, downloadUrl })
          }
          return
        }
        if (target?.closest('[data-image-viewer-close="1"]')) {
          latestImageViewerCloseHandler?.()
          return
        }
        if (target?.matches('[data-image-viewer-backdrop="1"]')) {
          latestImageViewerCloseHandler?.()
        }
      })
    }

    if (!imageViewerEscListenerAttached) {
      imageViewerEscListenerAttached = true
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return
        latestImageViewerCloseHandler?.()
      })
    }

    // Handler референциите се обновяват при ВСЕКИ render (свеж `options`
    // closure), но самите listener-и (click/keydown) се attach-ват само
    // веднъж — виж module-level guard-овете по-горе.
    latestImageViewerOpenHandler = (attachment) => options.onImageViewerOpen(attachment)
    latestImageViewerCloseHandler = state.imageViewer ? () => options.onImageViewerClose() : null
  }

  // ─── UI polish pass v2: Topics desktop shell = РЕАЛНАТА рендирана navbar
  // ширина ─────────────────────────────────────────────────────────────────
  //
  // Root cause на предишния опит (max-width:1640px reuse): nav (`renderNav`)
  // има `margin:0 auto` за центриране — а auto margins на cross-axis-а на
  // flex item ИЗКЛЮЧВАТ align-items:stretch (spec поведение) и вместо това
  // карат nav да се самоопредели по max-content (сумата от logo+бутони+gaps),
  // центриран чрез auto margins, capped единствено от max-width:1640px,
  // никога реално достигнат. Затова nav рендира ~1260-1330px, докато Topics
  // content wrapper-ът (без auto-margin self-centering — просто `width:100%`
  // вътре в ВЕЧЕ центриран 1640px родител) реално ЗАПЪЛВА тези 1640px.
  // Двете стойности са фундаментално различни механизми — споделеният
  // max-width taван не гарантира еднаква ФАКТИЧЕСКИ рендирана ширина.
  //
  // nav-ът е content-driven (не мога/не трябва да го променям — user
  // изрично забрани пипане на navbar-а) — затова тук directly МЕРИМ
  // реалната му getBoundingClientRect().width СЛЕД render и я прилагаме
  // като max-width на Topics shell-а. Това е "reuse на реалната navbar shell
  // width логика", буквално — не копие на константа, която може да се
  // разсинхронизира ако nav съдържанието се промени (нови бутони, badge-ове).
  //
  // Само desktop (data-topics-desktop-shell съществува единствено в desktop
  // клона на markup-а по-горе — mobile изобщо няма nav/scale-stage структура,
  // затова querySelector тук естествено връща null на mobile, без нужда от
  // изричен isPhoneLayoutViewport() check).
  {
    const navEl = root.querySelector<HTMLElement>('nav')
    const topicsShellEl = root.querySelector<HTMLElement>('[data-topics-desktop-shell="1"]')
    if (navEl && topicsShellEl) {
      const navWidth = navEl.getBoundingClientRect().width
      // min(navWidth, наличната viewport ширина минус safe padding) идва
      // автоматично от CSS max-width семантиката — width:100% (вече в
      // markup-а) + max-width:navWidth означава браузърът естествено избира
      // по-малкото от двете, без допълнителна JS логика тук.
      if (navWidth > 0) {
        topicsShellEl.style.maxWidth = `${Math.round(navWidth)}px`
      }
    }
  }

  // ─── Topics Moderation (Етап 4) ────────────────────────────────────────
  // Likes/replies/card-open за отделните съобщения вече са wire-нати по-горе
  // от wireTopicMessageNode loop-а (виж "Per-message wiring" коментара).
  root.querySelector<HTMLButtonElement>('[data-topic-thread-back="1"]')?.addEventListener('click', () => {
    options.onTopicThreadBack()
  })

  root.querySelector<HTMLButtonElement>('[data-topic-lock]')?.addEventListener('click', (event) => {
    const btn = event.currentTarget as HTMLButtonElement
    const topicId = btn.dataset.topicLock ?? ''
    const topicTitle = btn.dataset.topicLockTitle ?? ''
    if (topicId) options.onTopicLockClick(topicId, topicTitle)
  })

  root.querySelector<HTMLButtonElement>('[data-topic-unlock]')?.addEventListener('click', (event) => {
    const topicId = (event.currentTarget as HTMLButtonElement).dataset.topicUnlock ?? ''
    if (topicId) options.onTopicUnlockClick(topicId)
  })

  root.querySelector<HTMLButtonElement>('[data-topic-delete]')?.addEventListener('click', (event) => {
    const btn = event.currentTarget as HTMLButtonElement
    const topicId = btn.dataset.topicDelete ?? ''
    const topicTitle = btn.dataset.topicDeleteTitle ?? ''
    if (topicId) options.onTopicDeleteClick(topicId, topicTitle)
  })

  root.querySelector<HTMLButtonElement>('[data-topic-report="1"]')?.addEventListener('click', () => {
    options.onTopicReportClick()
  })

  // Lock/Mute/Unmute action popup — споделен form wiring (duration select +
  // reason textarea + cancel/submit), discriminated по kind (lock/mute) на
  // controller ниво; unmute popup reuse-ва СЪЩИТЕ data-topic-moderation-cancel/
  // data-topic-moderation-submit маркери (без duration/reason UI, виж
  // renderTopicModerationActionPopup early branch).
  root.querySelectorAll<HTMLButtonElement>('[data-topic-moderation-duration]').forEach((btn) => {
    const durationMs = Number.parseInt(btn.dataset.topicModerationDuration ?? '', 10)
    if (!Number.isFinite(durationMs)) return
    btn.addEventListener('click', () => {
      options.onTopicModerationActionDurationChange(durationMs)
    })
  })

  root.querySelector<HTMLTextAreaElement>('[data-topic-moderation-reason="1"]')?.addEventListener('input', (event) => {
    options.onTopicModerationActionReasonChange((event.currentTarget as HTMLTextAreaElement).value)
  })

  root.querySelector<HTMLSelectElement>('[data-topic-moderation-reason-category="1"]')?.addEventListener('change', (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value
    options.onTopicModerationActionReasonCategoryChange(
      value === '' ? null : (value as 'insults' | 'provocation' | 'spam' | 'inappropriate_content' | 'other'),
    )
  })

  root.querySelector<HTMLButtonElement>('[data-topic-moderation-cancel="1"]')?.addEventListener('click', () => {
    options.onTopicModerationActionPopupClose()
  })

  root.querySelector<HTMLButtonElement>('[data-topic-moderation-submit="1"]')?.addEventListener('click', () => {
    options.onTopicModerationActionSubmit()
  })

  root.querySelector<HTMLButtonElement>('[data-topic-mute-history-open="1"]')?.addEventListener('click', () => {
    options.onTopicMuteHistoryOpen()
  })

  root.querySelector<HTMLButtonElement>('[data-topics-section-mute-popup-ack="1"]')?.addEventListener('click', () => {
    options.onTopicsSectionMutePopupAcknowledge()
  })

  root.querySelector<HTMLButtonElement>('[data-topics-section-mute-popup-history="1"]')?.addEventListener('click', () => {
    options.onTopicsSectionMutePopupHistoryOpen()
  })

  root.querySelector<HTMLButtonElement>('[data-topic-mute-history-close="1"]')?.addEventListener('click', () => {
    options.onTopicMuteHistoryClose()
  })

  root.querySelectorAll<HTMLButtonElement>('[data-topic-mute-history-open-for-profile]').forEach((btn) => {
    const profileId = btn.dataset.topicMuteHistoryOpenForProfile ?? ''
    if (!profileId) return
    btn.addEventListener('click', () => {
      options.onTopicMuteHistoryOpenForProfile(profileId)
    })
  })

  root.querySelector<HTMLButtonElement>('[data-topic-mute-history-close-for-profile="1"]')?.addEventListener('click', () => {
    options.onTopicMuteHistoryCloseForProfile()
  })

  // Delete confirm — двустъпков (reason → confirm), виж renderTopicDeleteConfirmPopup.
  root.querySelector<HTMLTextAreaElement>('[data-topic-delete-reason="1"]')?.addEventListener('input', (event) => {
    options.onTopicDeleteReasonChange((event.currentTarget as HTMLTextAreaElement).value)
  })

  root.querySelector<HTMLButtonElement>('[data-topic-delete-cancel="1"]')?.addEventListener('click', () => {
    options.onTopicDeleteConfirmClose()
  })

  root.querySelector<HTMLButtonElement>('[data-topic-delete-advance="1"]')?.addEventListener('click', () => {
    options.onTopicDeleteAdvance()
  })

  root.querySelector<HTMLButtonElement>('[data-topic-delete-confirm="1"]')?.addEventListener('click', () => {
    options.onTopicDeleteConfirmSubmit()
  })

  // Individual message/reply moderation delete/edit wiring вече е покрито от
  // wireTopicMessageNode loop-а по-горе (delete/edit/edit-form/edit-text/
  // edit-cancel са всички per-message/per-reply markers, вложени вътре в
  // [data-topic-message]/[data-topic-reply] wrapper-а).

  root.querySelector<HTMLDivElement>('[data-topic-message-delete-confirm-backdrop="1"]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      options.onTopicMessageDeleteConfirmClose()
    }
  })

  root.querySelector<HTMLButtonElement>('[data-topic-message-delete-cancel="1"]')?.addEventListener('click', () => {
    options.onTopicMessageDeleteConfirmClose()
  })

  root.querySelector<HTMLButtonElement>('[data-topic-message-delete-confirm="1"]')?.addEventListener('click', () => {
    options.onTopicMessageDeleteConfirmSubmit()
  })

  // Report popup.
  root.querySelector<HTMLTextAreaElement>('[data-topic-report-reason="1"]')?.addEventListener('input', (event) => {
    options.onTopicReportReasonChange((event.currentTarget as HTMLTextAreaElement).value)
  })

  root.querySelector<HTMLButtonElement>('[data-topic-report-cancel="1"]')?.addEventListener('click', () => {
    options.onTopicReportPopupClose()
  })

  root.querySelector<HTMLButtonElement>('[data-topic-report-submit="1"]')?.addEventListener('click', () => {
    options.onTopicReportSubmit()
  })

  root.querySelectorAll<HTMLButtonElement>('[data-topic-replies-load-more]').forEach((btn) => {
    const rootMessageId = btn.dataset.topicRepliesLoadMore ?? ''
    if (!rootMessageId) return
    btn.addEventListener('click', () => {
      options.onTopicRepliesLoadMore(rootMessageId)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-topics-reply-composer-cancel]').forEach((btn) => {
    const rootMessageId = btn.dataset.topicsReplyComposerCancel ?? ''
    if (!rootMessageId) return
    btn.addEventListener('click', () => {
      options.onTopicReplyComposerCancel(rootMessageId)
    })
  })

  root.querySelectorAll<HTMLFormElement>('[data-topics-reply-composer-form="1"]').forEach((form) => {
    const rootMessageId = form.dataset.topicsReplyComposerRootId ?? ''
    if (!rootMessageId) return
    const textarea = form.querySelector<HTMLTextAreaElement>('[data-topics-reply-composer-text="1"]')
    const isVipLocked = form.dataset.topicsReplyComposerVipLocked === '1'

    form.addEventListener('submit', (e) => {
      e.preventDefault()
      if (isVipLocked) {
        options.onTopicReplyComposerNonVipTap()
        return
      }
      options.onTopicReplyComposerSubmit(rootMessageId)
    })

    if (textarea) {
      autoGrowTextarea(textarea)
      if (isVipLocked) {
        textarea.addEventListener('pointerdown', (event) => {
          event.preventDefault()
          options.onTopicReplyComposerNonVipTap()
        })
        textarea.addEventListener('click', (event) => {
          event.preventDefault()
          options.onTopicReplyComposerNonVipTap()
        })
      }
      textarea.addEventListener('input', () => {
        if (isVipLocked) return
        options.onTopicReplyComposerInput(rootMessageId, textarea.value)
        autoGrowTextarea(textarea)
      })
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          if (isVipLocked) {
            options.onTopicReplyComposerNonVipTap()
            return
          }
          options.onTopicReplyComposerSubmit(rootMessageId)
        }
      })
    }

    // Reply composer се render-ва САМО за VIP (виж коментара при
    // renderInlineReplyComposer) — non-VIP tap interception не е нужна тук.
    const replyImagePickBtn = form.querySelector<HTMLButtonElement>(`[data-topics-reply-image-pick="${cssEscape(rootMessageId)}"]`)
    const replyImageInput = form.querySelector<HTMLInputElement>(`[data-topics-reply-image-input="${cssEscape(rootMessageId)}"]`)
    const replyImageRemoveBtn = form.querySelector<HTMLButtonElement>(`[data-topics-reply-image-remove="${cssEscape(rootMessageId)}"]`)

    replyImagePickBtn?.addEventListener('click', () => {
      if (isVipLocked) {
        options.onTopicReplyComposerNonVipTap()
        return
      }
      replyImageInput?.click()
    })
    replyImageInput?.addEventListener('change', () => {
      const file = replyImageInput.files?.[0] ?? null
      replyImageInput.value = ''
      if (file !== null) {
        options.onTopicReplyComposerImageSelect(rootMessageId, file)
      }
    })
    replyImageRemoveBtn?.addEventListener('click', () => {
      options.onTopicReplyComposerImageRemove(rootMessageId)
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

  root.querySelectorAll<HTMLInputElement>('[data-lobby-shop-package-top-offer]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const packageId = checkbox.dataset.lobbyShopPackageTopOffer?.trim() ?? ''

      if (packageId.length > 0) {
        options.onAdminCoinPackageTopOfferToggle(packageId, checkbox.checked)
      }
    })
  })

  root.querySelectorAll<HTMLInputElement>('[data-lobby-admin-package-top-offer]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const packageId = checkbox.dataset.lobbyAdminPackageTopOffer?.trim() ?? ''

      if (packageId.length > 0) {
        options.onAdminCoinPackageTopOfferToggle(packageId, checkbox.checked)
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
    .querySelector<HTMLButtonElement>('[data-lobby-nav-admin-tournaments="1"]')
    ?.addEventListener('click', () => {
      if (adminDropdown) adminDropdown.style.display = 'none'
      options.onAdminTournamentsOpen?.()
    })

  root
    .querySelectorAll<HTMLButtonElement>('[data-lobby-nav-admin-guest-contact="1"]')
    .forEach((button) => button.addEventListener('click', () => {
      if (adminDropdown) adminDropdown.style.display = 'none'
      if (adminMailDropdown) adminMailDropdown.style.display = 'none'
      options.onAdminGuestContactMessagesClick()
    }))

  root
    .querySelectorAll<HTMLButtonElement>('[data-lobby-nav-admin-topic-reports="1"]')
    .forEach((button) => button.addEventListener('click', () => {
      if (adminDropdown) adminDropdown.style.display = 'none'
      if (adminMailDropdown) adminMailDropdown.style.display = 'none'
      options.onAdminTopicReportsOpen()
    }))

  root.querySelector<HTMLButtonElement>('[data-admin-topic-reports-close="1"]')?.addEventListener('click', () => {
    options.onAdminTopicReportsClose()
  })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-topic-reports-filter]').forEach((btn) => {
    const raw = btn.dataset.adminTopicReportsFilter ?? ''
    const status = raw === 'all' ? null : (raw as 'pending' | 'reviewed' | 'dismissed')
    btn.addEventListener('click', () => {
      options.onAdminTopicReportsFilterChange(status)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-topic-report-review]').forEach((btn) => {
    const reportId = btn.dataset.adminTopicReportReview ?? ''
    const status = btn.dataset.adminTopicReportReviewStatus === 'dismissed' ? 'dismissed' : 'reviewed'
    if (!reportId) return
    btn.addEventListener('click', () => {
      options.onAdminTopicReportReview(reportId, status)
    })
  })

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

  root
    .querySelector<HTMLButtonElement>('[data-lobby-chat-toggle-archived="1"]')
    ?.addEventListener('click', options.onChatToggleArchived)

  root.querySelectorAll<HTMLFormElement>('[data-lobby-chat-form]').forEach((form) => {
    keepComposerFocusOnPointerSubmit(form.querySelector<HTMLButtonElement>('button[type="submit"]'))
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const friendshipId = form.dataset.lobbyChatForm?.trim() ?? ''
      const data = new FormData(form)
      const body = String(data.get('message') ?? '').trim()
      const hasPendingImage = Boolean(state.chatPendingImageByFriendshipId[friendshipId])

      // Позволяваме submit ако има ТЕКСТ ИЛИ избрана снимка (или и двете) —
      // самата снимка се чете от state в sendChatMessage
      // (createLobbyFlowController.ts), не се подава тук.
      if (friendshipId.length > 0 && (body.length > 0 || hasPendingImage)) {
        // Не чистим полето/черновата тук — резултатът от изпращането все още не е
        // известен. Черновата се изчиства едва след потвърден успех от сървъра
        // (виж sendChatMessage в createLobbyFlowController.ts); при неуспех текстът остава.
        options.onChatSubmit(friendshipId, body)
      }
    })
  })

  root.querySelectorAll<HTMLInputElement>('[data-lobby-chat-message-input="1"]').forEach((input) => {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.isComposing) {
        event.preventDefault()
      }
    })
    input.addEventListener('input', () => {
      const friendshipId = input.closest('form')?.dataset.lobbyChatForm?.trim() ?? ''
      if (friendshipId.length > 0) {
        options.onChatDraftChange(friendshipId, input.value)
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

  root.querySelectorAll<HTMLButtonElement>('[data-chat-image-pick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const friendshipId = btn.dataset.chatImagePick?.trim() ?? ''
      const input = root.querySelector<HTMLInputElement>(
        `[data-chat-image-input="${CSS.escape(friendshipId)}"]`,
      )
      input?.click()
    })
  })

  root.querySelectorAll<HTMLInputElement>('[data-chat-image-input]').forEach((input) => {
    input.addEventListener('change', () => {
      const friendshipId = input.dataset.chatImageInput?.trim() ?? ''
      const file = input.files?.[0] ?? null
      // Ресетваме value веднага — позволява на потребителя да избере СЪЩИЯ
      // файл отново (напр. след премахване), браузърът иначе не би emit-нал
      // 'change' за идентичен избор.
      input.value = ''
      if (friendshipId.length > 0 && file !== null) {
        options.onChatImageSelect(friendshipId, file)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-chat-image-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const friendshipId = btn.dataset.chatImageRemove?.trim() ?? ''
      if (friendshipId.length > 0) {
        options.onChatImageRemove(friendshipId)
      }
    })
  })

  // "Публикации от Pika.bg" в лобито (херо карето / mobile лента):
  // - Гост-версия на формата носи data-lobby-livechat-guest-gate: submit и
  //   клик/фокус върху полето отварят auth попъпа вместо реално изпращане
  //   (сървърът и без това би отказал непостоянен профил, но за гост UX-ът
  //   е "обясни защо", не грешка).
  // - Логнат-без-право версия носи data-lobby-livechat-write-locked-gate:
  //   pointerdown/click pattern mirror на Topics non-VIP composer (виж
  //   isVipLocked блока по-долу за пълния rationale) — pointerdown само
  //   preventDefault() (спира mobile keyboard focus навреме), click отваря
  //   "Публикации от Pika.bg" попъпа едва след завършен tap цикъл, за да
  //   не падне tap "остатък" върху вече отворения backdrop и да го затвори.
  root.querySelectorAll<HTMLFormElement>('[data-lobby-livechat-form="1"]').forEach((form) => {
    const isGuestGated = form.hasAttribute('data-lobby-livechat-guest-gate')
    const isWriteLockedGated = form.hasAttribute('data-lobby-livechat-write-locked-gate')

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (isGuestGated) {
        options.onAuthModeChange('lobby-chat-guest')
        return
      }
      if (isWriteLockedGated) {
        options.onLobbyChatWriteLockedTap()
        return
      }
      options.onLobbyChatSubmit()
    })

    const input = form.querySelector<HTMLInputElement>('[data-lobby-livechat-input="1"]')
    const sendBtn = form.querySelector<HTMLButtonElement>('[data-lobby-livechat-send="1"]')

    if (isGuestGated) {
      input?.addEventListener('click', () => options.onAuthModeChange('lobby-chat-guest'))
      input?.addEventListener('focus', () => {
        input.blur()
        options.onAuthModeChange('lobby-chat-guest')
      })
    } else if (isWriteLockedGated) {
      input?.addEventListener('pointerdown', (event) => {
        event.preventDefault()
      })
      input?.addEventListener('click', (event) => {
        event.preventDefault()
        options.onLobbyChatWriteLockedTap()
      })
      sendBtn?.addEventListener('click', (event) => {
        event.preventDefault()
        options.onLobbyChatWriteLockedTap()
      })
    } else if (input) {
      input.addEventListener('input', () => options.onLobbyChatDraftChange(input.value))
    }
  })

  root
    .querySelectorAll<HTMLButtonElement>('[data-lobby-livechat-write-locked-modal-close="1"]')
    .forEach((btn) => btn.addEventListener('click', options.onLobbyChatWriteLockedPopupClose))

  root
    .querySelector<HTMLElement>('[data-lobby-livechat-write-locked-modal-backdrop="1"]')
    ?.addEventListener('click', options.onLobbyChatWriteLockedPopupClose)

  root
    .querySelector<HTMLElement>('[data-lobby-livechat-write-locked-modal-root="1"]')
    ?.addEventListener('click', options.onLobbyChatWriteLockedPopupClose)
  root
    .querySelector<HTMLElement>('[data-lobby-livechat-write-locked-modal-root="1"] [role="dialog"]')
    ?.addEventListener('click', (e) => e.stopPropagation())

  root
    .querySelector<HTMLButtonElement>('[data-lobby-livechat-write-locked-goto-topics="1"]')
    ?.addEventListener('click', options.onLobbyChatWriteLockedGotoTopics)

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-livechat-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const messageId = btn.dataset.lobbyLivechatDelete?.trim() ?? ''
      if (messageId.length > 0) {
        options.onLobbyChatDelete(messageId)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-livechat-fullscreen-toggle="1"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      options.onLobbyChatFullscreenChange(!state.lobbyChatFullscreen)
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

  // Pagination — еднакво wiring за горния и долния pager (и desktop, и mobile).
  root.querySelectorAll<HTMLButtonElement>('[data-lobby-players-page]').forEach((button) => {
    button.addEventListener('click', () => {
      const raw = button.dataset.lobbyPlayersPage ?? ''
      const targetPage =
        raw === 'prev' ? state.playersPage - 1
        : raw === 'next' ? state.playersPage + 1
        : Number.parseInt(raw, 10)

      if (Number.isFinite(targetPage)) {
        options.onPlayersPageChange(targetPage)
      }
    })
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
        isTopOffer: data.get('isTopOffer') === 'on',
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
    onPrivateRoomInGameNotificationsChange: options.onPrivateRoomInGameNotificationsChange,
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

  // Управление на профил попъпа директно на document.body (без участие в
  // root.innerHTML) — този sync се вика при ВСЕКИ render (badge/WS/presence
  // и т.н.), не само при explicit popup действия (renderPopupOnly в
  // createLobbyFlowController.ts). isOwnProfile/ownVipActiveUntil ТРЯБВА да
  // се преизчисляват тук по същия начин, иначе следващ несвързан re-render
  // ги презаписва обратно към false/null (production data-flow bug,
  // фиксиран тук — виж renderOwnProfileSummary/renderVipBadge).
  const profilePopupResolvedProfile = state.profilePopupProfile ?? state.profile
  const profilePopupIsOwnProfile = profilePopupResolvedProfile.profileId !== null
    && profilePopupResolvedProfile.profileId === state.profile.profileId
  syncProfilePopup(
    {
      isOpen: state.profilePopupOpen,
      profile: profilePopupResolvedProfile,
      canEdit: state.profilePopupCanEdit,
      isAdmin: state.isAdmin,
      isOwnProfile: profilePopupIsOwnProfile,
      friendshipAction: state.friendshipAction,
      viewerIsFullAdmin: state.isAdmin,
      targetAccountRole: state.profilePopupTargetRole,
      showPikaSupportChatButton: state.showPikaSupportChatButton,
      showTopicsPersonalMessageButton: false,
      ownVipActiveUntil: profilePopupIsOwnProfile ? state.ownVipActiveUntil : null,
      vipGrantOpen: state.vipGrantOpen,
      vipGrantSubmitting: state.vipGrantSubmitting,
      vipGrantErrorText: state.vipGrantErrorText,
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
      onPikaSupportChatClick: options.onPikaSupportChatClick,
      onTopicsPersonalMessageClick: () => {},
      onLikeClick: options.onLikeClick,
      onGrantSubadminClick: options.onProfileGrantSubadminClick,
      onRevokeSubadminClick: options.onProfileRevokeSubadminClick,
      onGrantChatAdminClick: options.onProfileGrantChatAdminClick,
      onRevokeChatAdminClick: options.onProfileRevokeChatAdminClick,
      onGrantPikaTeamClick: options.onProfileGrantPikaTeamClick,
      onRevokePikaTeamClick: options.onProfileRevokePikaTeamClick,
      onGrantTopChatAdminClick: options.onProfileGrantTopChatAdminClick,
      onRevokeTopChatAdminClick: options.onProfileRevokeTopChatAdminClick,
      onVipGrantOpen: options.onProfileVipGrantOpen,
      onVipGrantCancel: options.onProfileVipGrantCancel,
      onVipGrantSubmit: options.onProfileVipGrantSubmit,
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
  const profileNameValidationOptions: ProfileDisplayNameValidationOptions = {
    profileId: editorProfile.profileId,
  }
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

  function openCropOverlay(file: File, decodedImage: DecodedProfileImageFile): void {
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

    overlayImage.src = decodedImage.imageUrl

    let pendingCrop: AvatarCropSelection | null = null

    setupSquareCropInteraction({
      box: overlayBox,
      image: overlayImage,
      selection: overlaySelection,
      onCropChange: (crop) => {
        pendingCrop = crop
      },
    })

    overlay.querySelector<HTMLButtonElement>('[data-crop-confirm="1"]')?.addEventListener('click', (event) => {
      const button = event.currentTarget as HTMLButtonElement
      if (button.disabled) return
      if (pendingCrop === null) {
        options.onProfileEditorFileError('Очертай квадрат върху снимката.')
        return
      }
      button.disabled = true
      button.style.opacity = '0.62'
      button.style.cursor = 'default'
      _pendingAvatarCrop = pendingCrop
      overlay.remove()

      if (_pendingAvatarCrop !== null) {
        _pendingAvatarFile = file
        const crop = _pendingAvatarCrop
        const canvas = document.createElement('canvas')
        canvas.width = 250
        canvas.height = 250
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          decodedImage.revoke()
          _pendingAvatarFile = null
          _pendingAvatarCrop = null
          options.onProfileEditorFileError('Снимката е повредена или не може да бъде прочетена. Моля, изберете друг файл.')
          return
        }
          const img = new Image()
          img.onload = () => {
            ctx.drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, 250, 250)
            const dataUrl = canvas.toDataURL('image/webp')
            _pendingAvatarPreviewDataUrl = dataUrl
            const preview = root.querySelector<HTMLElement>('[data-avatar-preview="1"]')
            if (preview) {
              preview.innerHTML = `<img src="${dataUrl}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">`
            }
            decodedImage.revoke()
            options.onProfileEditorFileError(null)
          }
        img.onerror = () => {
          decodedImage.revoke()
          _pendingAvatarFile = null
          _pendingAvatarCrop = null
          options.onProfileEditorFileError('Снимката е повредена или не може да бъде прочетена. Моля, изберете друг файл.')
        }
        img.src = decodedImage.imageUrl
      }
    })

    overlay.querySelector('[data-crop-cancel="1"]')?.addEventListener('click', () => {
      _pendingAvatarFile = null
      _pendingAvatarCrop = null
      _pendingAvatarPreviewDataUrl = null
      avatarInput.value = ''
      decodedImage.revoke()
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
    _pendingAvatarCrop = null
    _pendingAvatarFile = null
    if (!file) return
    avatarInput.value = ''
    options.onProfileEditorFileError(null)
    void (async () => {
      const decoded = await decodeProfileImageFile(file)
      if (!decoded.ok) {
        _pendingAvatarFile = null
        _pendingAvatarCrop = null
        _pendingAvatarPreviewDataUrl = null
        avatarInput.value = ''
        options.onProfileEditorFileError(decoded.message)
        return
      }
      openCropOverlay(file, decoded.image)
    })()
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

  function openGalleryCropOverlay(file: File, decodedImage: DecodedProfileImageFile): void {
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
    overlayImage.src = decodedImage.imageUrl

    let pendingCrop: AvatarCropSelection | null = null

    setupSquareCropInteraction({
      box: overlayBox,
      image: overlayImage,
      selection: overlaySelection,
      onCropChange: (crop) => {
        pendingCrop = crop
      },
    })

    overlay.querySelector<HTMLButtonElement>('[data-gallery-crop-confirm="1"]')?.addEventListener('click', (event) => {
      const button = event.currentTarget as HTMLButtonElement
      if (button.disabled) return
      if (pendingCrop === null) {
        options.onProfileEditorFileError('Очертай квадрат върху снимката.')
        return
      }
      button.disabled = true
      button.style.opacity = '0.62'
      button.style.cursor = 'default'
      const crop = pendingCrop
      const canvas = document.createElement('canvas')
      canvas.width = 800
      canvas.height = 800
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        decodedImage.revoke()
        overlay.remove()
        return
      }
      const img = new Image()
      img.onload = () => {
        ctx.drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, 800, 800)
        const dataUrl = canvas.toDataURL('image/webp', 0.92)
        decodedImage.revoke()
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
      img.onerror = () => {
        decodedImage.revoke()
        options.onProfileEditorFileError('Снимката е повредена или не може да бъде прочетена. Моля, изберете друг файл.')
        overlay.remove()
      }
      img.src = decodedImage.imageUrl
    })

    overlay.querySelector('[data-gallery-crop-cancel="1"]')?.addEventListener('click', () => {
      decodedImage.revoke()
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
    options.onProfileEditorFileError(null)
    void (async () => {
      const decoded = await decodeProfileImageFile(file)
      if (!decoded.ok) {
        galleryFileInput.value = ''
        options.onProfileEditorFileError(decoded.message)
        return
      }
      openGalleryCropOverlay(file, decoded.image)
    })()
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
      if (state.profileEditorSubmitting) return
      const galleryFiles = _pendingGalleryItems.map((item, i) => dataUrlToFile(item.dataUrl, `gallery-${i}.webp`))
      options.onProfileEditSubmit(
        _pendingAvatarFile ?? null,
        _pendingAvatarCrop,
        galleryFiles,
      )
    })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-profile-name-change-submit="1"]')
    ?.addEventListener('click', () => {
      const input = root.querySelector<HTMLInputElement>('input[name="paidDisplayName"]')
      const validation = validateProfileDisplayName(input?.value ?? '', profileNameValidationOptions)
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
    validationOptions: ProfileDisplayNameValidationOptions = {},
  ): void {
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastChecked = ''

    const setHint = (text: string, color = ''): void => {
      hintEl.textContent = text
      hintEl.title = text
      hintEl.style.color = color
    }

    input.addEventListener('blur', () => {
      const validation = validateProfileDisplayName(input.value, validationOptions)
      if (validation.ok) {
        input.value = validation.canonicalDisplayName
      }
    })

    input.addEventListener('input', () => {
      const validation = validateProfileDisplayName(input.value, validationOptions)

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

      const value = getProfileDisplayNameAvailabilityQuery(input.value, validationOptions)
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
          const currentValidation = validateProfileDisplayName(input.value, validationOptions)
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
    if (input && hint) {
      attachNameAvailabilityCheck(input, hint, key === 'namechange' ? profileNameValidationOptions : {})
    }
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
      const stake = Number(data.get('stake')) as MatchStake
      if (!Number.isInteger(stake) || stake < 1) return
      const isLocked = (data.get('isLocked') ?? null) !== null
      const rawWaitMinutes = Number(data.get('waitMinutes'))
      const waitMinutes: 5 | 10 | 15 | 30 = [5, 10, 15, 30].includes(rawWaitMinutes)
        ? (rawWaitMinutes as 5 | 10 | 15 | 30)
        : 15
      options.onPrivateRoomCreate(stake, isLocked, waitMinutes)
    })

  // Отделен бутон от "+"-ите по-долу (различно DOM поддърво в roomRowHtml) —
  // клик върху зает seat/avatar никога не тригва join.
  root.querySelectorAll<HTMLButtonElement>('[data-private-room-member]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const profileId = btn.dataset.privateRoomMember?.trim() ?? ''
      const displayName = btn.dataset.privateRoomMemberName?.trim() ?? ''
      if (profileId) options.onPrivateRoomMemberClick(profileId, displayName)
    })
  })

  // Директен "+" на конкретен свободен слот в списъка (не собствената маса) —
  // отваря join-confirm popup-а за точно този (roomId, team, slotIndex).
  root.querySelectorAll<HTMLButtonElement>('[data-private-room-list-slot-join]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = btn.getAttribute('data-private-room-list-slot-join')
      if (raw === null) return
      const [roomId, teamRaw, slotIndexRaw] = raw.split(':')
      if (!roomId || (teamRaw !== 'A' && teamRaw !== 'B')) return
      const slotIndex = slotIndexRaw === '0' ? 0 : slotIndexRaw === '1' ? 1 : null
      if (slotIndex === null) return
      options.onPrivateRoomListSlotJoinOpen(roomId, teamRaw, slotIndex)
    })
  })

  // Join-confirm popup — споделен markup/data-* атрибути с
  // renderPrivateRoomWaitingScreen.ts (никога не са монтирани едновременно).
  root.querySelector<HTMLButtonElement>('[data-private-room-join-popup-confirm="1"]')
    ?.addEventListener('click', () => options.onPrivateRoomJoinSlotPopupConfirm())

  root.querySelector<HTMLButtonElement>('[data-private-room-join-popup-cancel="1"]')
    ?.addEventListener('click', () => options.onPrivateRoomJoinSlotPopupCancel())

  root.querySelector<HTMLElement>('[data-private-room-join-popup-backdrop="1"]')
    ?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) options.onPrivateRoomJoinSlotPopupCancel()
    })

  root.querySelector<HTMLButtonElement>('[data-private-room-blocked-popup-close="1"]')
    ?.addEventListener('click', () => options.onPrivateRoomBlockedPopupClose())

  root.querySelector<HTMLElement>('[data-private-room-blocked-popup-backdrop="1"]')
    ?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) options.onPrivateRoomBlockedPopupClose()
    })

  // "ВЛЕЗ" на собствената маса в списъка — чиста навигация, без нов join.
  root.querySelectorAll<HTMLButtonElement>('[data-private-room-list-enter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-private-room-list-enter')
      if (id) options.onPrivateRoomListEnter(id)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-tournament-create-open="1"]')
    .forEach((btn) => btn.addEventListener('click', options.onTournamentCreatePopupOpen))

  root.querySelector<HTMLButtonElement>('[data-tournament-create-close="1"]')
    ?.addEventListener('click', options.onTournamentCreatePopupClose)

  root.querySelector<HTMLElement>('[data-tournament-create-backdrop="1"]')
    ?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) options.onTournamentCreatePopupClose()
    })

  root.querySelectorAll<HTMLButtonElement>('[data-tournament-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const filter = btn.dataset.tournamentFilter
      if (filter === 'all' || filter === 'mine') options.onTournamentsFilterChange(filter)
    })
  })

  root.querySelectorAll<HTMLElement>('[data-tournament-card]').forEach((card) => {
    card.addEventListener('click', () => {
      const tournamentId = card.dataset.tournamentCard?.trim() ?? ''
      if (tournamentId) options.onTournamentCardClick(tournamentId)
    })
  })

  root.querySelector<HTMLButtonElement>('[data-tournament-detail-back="1"]')
    ?.addEventListener('click', options.onTournamentsClick)

  root.querySelectorAll<HTMLButtonElement>('[data-tournament-how-it-works-open="1"]')
    .forEach((btn) => btn.addEventListener('click', options.onTournamentHowItWorksOpen))

  root.querySelectorAll<HTMLButtonElement>('[data-tournament-how-it-works-back="1"]')
    .forEach((btn) => btn.addEventListener('click', options.onTournamentsClick))

  {
    const createForm = root.querySelector<HTMLFormElement>('[data-tournament-create-form="1"]')
    const visibilityRadios = root.querySelectorAll<HTMLInputElement>('[data-tournament-create-form="1"] input[name="visibility"]')
    const passwordField = root.querySelector<HTMLElement>('[data-tournament-create-password-field="1"]')
    const startModeRadios = root.querySelectorAll<HTMLInputElement>('[data-tournament-create-form="1"] input[name="startMode"]')
    const scheduledField = root.querySelector<HTMLElement>('[data-tournament-create-scheduled-field="1"]')
    const fillField = root.querySelector<HTMLElement>('[data-tournament-create-fill-field="1"]')
    const entryFeeSelect = root.querySelector<HTMLSelectElement>('[data-tournament-create-entryfee="1"]')
    const teamCapacitySelect = root.querySelector<HTMLSelectElement>('[data-tournament-create-teamcapacity="1"]')
    const previewBox = root.querySelector<HTMLElement>('[data-tournament-create-preview="1"]')

    function syncVisibilityFields(): void {
      const selected = root.querySelector<HTMLInputElement>('[data-tournament-create-form="1"] input[name="visibility"]:checked')?.value
      if (passwordField) passwordField.style.display = selected === 'password' ? 'block' : 'none'
    }
    function syncStartModeFields(): void {
      const selected = root.querySelector<HTMLInputElement>('[data-tournament-create-form="1"] input[name="startMode"]:checked')?.value
      if (scheduledField) scheduledField.style.display = selected === 'scheduled' ? 'block' : 'none'
      if (fillField) fillField.style.display = selected === 'fill' ? 'block' : 'none'
    }
    // Огледало на server calculateTournamentPrizePreview (20%/80%/65%/35%,
    // виж tournamentPrizeRules.ts) — playerCapacity = teamCapacity * 2,
    // никога хардкоднато на 8.
    function syncPrizePreview(): void {
      if (!previewBox || !entryFeeSelect) return
      const entryFee = Number(entryFeeSelect.value) || 0
      const teamCapacity = Number(teamCapacitySelect?.value) || 4
      const playerCapacity = teamCapacity * 2
      const totalEntryFees = entryFee * playerCapacity
      const systemFee = Math.trunc(totalEntryFees * 0.2)
      const prizePool = totalEntryFees - systemFee
      const firstTeamPrize = Math.trunc(prizePool * 0.65)
      const secondTeamPrize = prizePool - firstTeamPrize
      const fmt = (n: number) => new Intl.NumberFormat('bg-BG').format(n)
      const participantsEl = previewBox.querySelector('[data-preview-participants] span:last-child')
      const totalEl = previewBox.querySelector('[data-preview-total] span:last-child')
      const feeEl = previewBox.querySelector('[data-preview-fee] span:last-child')
      const poolEl = previewBox.querySelector('[data-preview-pool] span:last-child')
      const firstEl = previewBox.querySelector('[data-preview-first] span:last-child')
      const secondEl = previewBox.querySelector('[data-preview-second] span:last-child')
      if (participantsEl) participantsEl.textContent = String(playerCapacity)
      if (totalEl) totalEl.textContent = fmt(totalEntryFees)
      if (feeEl) feeEl.textContent = fmt(systemFee)
      if (poolEl) poolEl.textContent = fmt(prizePool)
      if (firstEl) firstEl.textContent = fmt(firstTeamPrize)
      if (secondEl) secondEl.textContent = fmt(secondTeamPrize)
    }

    visibilityRadios.forEach((radio) => radio.addEventListener('change', syncVisibilityFields))
    startModeRadios.forEach((radio) => radio.addEventListener('change', syncStartModeFields))
    entryFeeSelect?.addEventListener('change', syncPrizePreview)
    teamCapacitySelect?.addEventListener('change', syncPrizePreview)
    syncVisibilityFields()
    syncStartModeFields()

    createForm?.addEventListener('submit', (e) => {
      e.preventDefault()
      const input = extractTournamentCreateInputFromForm(createForm)
      if (input) options.onTournamentCreateSubmit(input)
    })
  }

  root.querySelector<HTMLInputElement>('[data-tournament-unlock-password="1"]')
    ?.addEventListener('input', (e) => {
      options.onTournamentDetailPasswordDraftChange((e.currentTarget as HTMLInputElement).value)
    })

  root.querySelector<HTMLButtonElement>('[data-tournament-unlock-submit="1"]')
    ?.addEventListener('click', options.onTournamentUnlockSubmit)

  root.querySelector<HTMLButtonElement>('[data-tournament-join-open="1"]')
    ?.addEventListener('click', options.onTournamentJoinConfirmOpen)
  root.querySelector<HTMLButtonElement>('[data-tournament-join-close="1"]')
    ?.addEventListener('click', options.onTournamentJoinConfirmClose)
  root.querySelector<HTMLButtonElement>('[data-tournament-join-submit="1"]')
    ?.addEventListener('click', options.onTournamentJoinSubmit)
  root.querySelector<HTMLElement>('[data-tournament-join-backdrop="1"]')
    ?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) options.onTournamentJoinConfirmClose()
    })
  root.querySelector<HTMLButtonElement>('[data-tournament-partner-picker-open="1"]')
    ?.addEventListener('click', options.onTournamentPartnerPickerOpen)
  root.querySelector<HTMLButtonElement>('[data-tournament-partner-picker-close="1"]')
    ?.addEventListener('click', options.onTournamentPartnerPickerClose)
  root.querySelector<HTMLElement>('[data-tournament-partner-picker-backdrop="1"]')
    ?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) options.onTournamentPartnerPickerClose()
    })
  root.querySelector<HTMLInputElement>('[data-tournament-partner-query="1"]')
    ?.addEventListener('input', (e) => {
      options.onTournamentPartnerInviteQueryChange((e.currentTarget as HTMLInputElement).value)
    })
  root.querySelectorAll<HTMLButtonElement>('[data-tournament-partner-invite]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const profileId = btn.dataset.tournamentPartnerInvite ?? ''
      if (profileId) options.onTournamentPartnerInviteSubmit(profileId)
    })
  })
  root.querySelectorAll<HTMLButtonElement>('[data-tournament-partner-accept]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const inviteId = btn.dataset.tournamentPartnerAccept ?? ''
      const tournamentId = btn.dataset.tournamentId ?? ''
      if (inviteId && tournamentId) options.onTournamentPartnerInviteAccept(tournamentId, inviteId)
    })
  })
  root.querySelectorAll<HTMLButtonElement>('[data-tournament-partner-decline]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const inviteId = btn.dataset.tournamentPartnerDecline ?? ''
      const tournamentId = btn.dataset.tournamentId ?? ''
      if (inviteId && tournamentId) options.onTournamentPartnerInviteDecline(tournamentId, inviteId)
    })
  })
  root.querySelectorAll<HTMLButtonElement>('[data-tournament-partner-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const inviteId = btn.dataset.tournamentPartnerCancel ?? ''
      const tournamentId = btn.dataset.tournamentId ?? ''
      if (inviteId && tournamentId) options.onTournamentPartnerInviteCancel(tournamentId, inviteId)
    })
  })

  root.querySelector<HTMLButtonElement>('[data-tournament-enter-active-match="1"]')
    ?.addEventListener('click', (event) => {
      const btn = event.currentTarget as HTMLButtonElement
      const roomId = btn.dataset.roomId?.trim() ?? ''
      const reconnectToken = btn.dataset.reconnectToken?.trim() ?? ''
      if (roomId && reconnectToken) {
        options.onTournamentEnterActiveMatch(roomId, reconnectToken)
      }
    })

  root.querySelector<HTMLButtonElement>('[data-tournament-leave-open="1"]')
    ?.addEventListener('click', options.onTournamentLeaveConfirmOpen)
  root.querySelector<HTMLButtonElement>('[data-tournament-leave-close="1"]')
    ?.addEventListener('click', options.onTournamentLeaveConfirmClose)
  root.querySelector<HTMLButtonElement>('[data-tournament-leave-submit="1"]')
    ?.addEventListener('click', options.onTournamentLeaveSubmit)
  root.querySelector<HTMLElement>('[data-tournament-leave-backdrop="1"]')
    ?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) options.onTournamentLeaveConfirmClose()
    })

  root.querySelector<HTMLButtonElement>('[data-tournament-cancel-open="1"]')
    ?.addEventListener('click', options.onTournamentCancelConfirmOpen)
  root.querySelector<HTMLButtonElement>('[data-tournament-cancel-close="1"]')
    ?.addEventListener('click', options.onTournamentCancelConfirmClose)
  root.querySelector<HTMLButtonElement>('[data-tournament-cancel-submit="1"]')
    ?.addEventListener('click', options.onTournamentCancelSubmit)
  root.querySelector<HTMLElement>('[data-tournament-cancel-backdrop="1"]')
    ?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) options.onTournamentCancelConfirmClose()
    })

  root.querySelectorAll<HTMLButtonElement>('[data-private-room-invite-open="1"]').forEach((btn) => {
    btn.addEventListener('click', options.onInviteFriendsOpen)
  })

  root.querySelector<HTMLButtonElement>('[data-private-room-invite-close="1"]')
    ?.addEventListener('click', options.onInviteFriendsClose)

  root.querySelector<HTMLElement>('[data-private-room-invite-backdrop="1"]')
    ?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) options.onInviteFriendsClose()
    })

  root.querySelectorAll<HTMLButtonElement>('[data-private-room-invite-send]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = btn.getAttribute('data-private-room-invite-send')
      if (!raw) return
      const [profileId, ...nameParts] = raw.split(':')
      const displayName = nameParts.join(':')
      if (profileId && displayName) options.onPrivateRoomInviteSend(profileId, displayName)
    })
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

  root.querySelector<HTMLButtonElement>('[data-private-room-conflict-return="1"]')
    ?.addEventListener('click', options.onPrivateRoomConflictReturnClick)

  root.querySelector<HTMLButtonElement>('[data-private-room-conflict-dismiss="1"]')
    ?.addEventListener('click', options.onPrivateRoomConflictDismiss)

  root.querySelector<HTMLButtonElement>('[data-subadmin-action-confirm="1"]')
    ?.addEventListener('click', options.onSubadminActionConfirm)

  root.querySelector<HTMLButtonElement>('[data-subadmin-action-cancel="1"]')
    ?.addEventListener('click', options.onSubadminActionCancel)

  root.querySelector<HTMLButtonElement>('[data-chat-admin-action-confirm="1"]')
    ?.addEventListener('click', options.onChatAdminActionConfirm)

  root.querySelector<HTMLButtonElement>('[data-chat-admin-action-cancel="1"]')
    ?.addEventListener('click', options.onChatAdminActionCancel)

  root.querySelector<HTMLButtonElement>('[data-pika-team-action-confirm="1"]')
    ?.addEventListener('click', options.onPikaTeamActionConfirm)

  root.querySelector<HTMLButtonElement>('[data-pika-team-action-cancel="1"]')
    ?.addEventListener('click', options.onPikaTeamActionCancel)

  root.querySelector<HTMLButtonElement>('[data-top-chat-admin-action-confirm="1"]')
    ?.addEventListener('click', options.onTopChatAdminActionConfirm)

  root.querySelector<HTMLButtonElement>('[data-top-chat-admin-action-cancel="1"]')
    ?.addEventListener('click', options.onTopChatAdminActionCancel)

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

  const newTopicMessagesScrollEl = root.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
  if (newTopicMessagesScrollEl && state.activeTopicId === LAFCHE_TOPIC_ID) {
    // "Лафче" — chat-style bottom-anchored scroll (Лафче брифа §3), напълно
    // отделно от General card-feed state machine-а по-долу (top-anchored,
    // prepend/near-top семантика — несъвместима с Лафче нуждите). 'initial'
    // (отваряне на Лафче) винаги отива до дъното; live-append дърпа до
    // дъното САМО ако viewer вече е бил близо до него (wasLafcheNearBottom),
    // иначе пази точната scroll позиция без "издърпване" — mirror на
    // wasTopicThreadNearBottom pattern-а (renderTopicThreadView).
    if (state.topicMessagesRenderReason === 'initial' || state.topicMessagesRenderReason === 'own-message') {
      newTopicMessagesScrollEl.scrollTop = newTopicMessagesScrollEl.scrollHeight
    } else if (state.topicMessagesRenderReason === 'live-append' || state.topicMessagesRenderReason === 'reconnect-refresh' || state.topicMessagesRenderReason === 'reorder') {
      newTopicMessagesScrollEl.scrollTop = wasLafcheNearBottom
        ? newTopicMessagesScrollEl.scrollHeight
        : savedTopicMessagesScrollTop
    } else if (prevTopicMessagesScrollEl !== null) {
      newTopicMessagesScrollEl.scrollTop = savedTopicMessagesScrollTop
    } else {
      newTopicMessagesScrollEl.scrollTop = newTopicMessagesScrollEl.scrollHeight
    }
  } else if (newTopicMessagesScrollEl) {
    if (explicitTopicMessagesScrollAnchor !== null) {
      const anchorEl = root.querySelector<HTMLElement>(`[data-topic-message="${cssEscape(explicitTopicMessagesScrollAnchor.messageId)}"]`)
      if (anchorEl) {
        newTopicMessagesScrollEl.scrollTop += anchorEl.getBoundingClientRect().top - explicitTopicMessagesScrollAnchor.top
      } else if (prevTopicMessagesScrollEl !== null) {
        newTopicMessagesScrollEl.scrollTop = savedTopicMessagesScrollTop
      }
    } else if (state.topicMessagesRenderReason === 'prepend' && stableTopicMessagesScrollAnchor !== null && stableTopicMessagesScrollAnchor.messageId.length > 0) {
      const anchorEl = root.querySelector<HTMLElement>(`[data-topic-message="${cssEscape(stableTopicMessagesScrollAnchor.messageId)}"]`)
      if (anchorEl) {
        newTopicMessagesScrollEl.scrollTop += anchorEl.getBoundingClientRect().top - stableTopicMessagesScrollAnchor.top
      } else if (savedTopicMessagesDistanceFromBottom !== null) {
        newTopicMessagesScrollEl.scrollTop = newTopicMessagesScrollEl.scrollHeight - savedTopicMessagesDistanceFromBottom
      }
    } else if (state.topicMessagesRenderReason === 'prepend' && savedTopicMessagesDistanceFromBottom !== null) {
      // Load older (scroll нагоре) — възстановяваме точната визуална позиция
      // чрез запазената delta от долния край, потребителят не "подскача".
      newTopicMessagesScrollEl.scrollTop = newTopicMessagesScrollEl.scrollHeight - savedTopicMessagesDistanceFromBottom
    } else if (state.topicMessagesRenderReason === 'live-append' || state.topicMessagesRenderReason === 'reconnect-refresh' || state.topicMessagesRenderReason === 'reorder') {
      // Ново live съобщение (WS push) или reconnect/truncated-catchup refresh
      // (Етап 2 брифа т.8) — near-bottom threshold, огледално на
      // wasLobbyChatNearBottom: не дърпаме насила потребител, който чете стари.
      newTopicMessagesScrollEl.scrollTop = wasTopicMessagesNearTop
        ? 0
        : savedTopicMessagesScrollTop
    } else if (state.topicMessagesRenderReason === 'initial' || state.topicMessagesRenderReason === 'own-message') {
      // 'initial' (първо зареждане на тема / превключване) или null — viewport
      // към последните съобщения (т.4 от Етап 1 брифа: "viewport е към
      // долната част/последните съобщения").
      newTopicMessagesScrollEl.scrollTop = 0
    } else if (stableTopicMessagesScrollAnchor !== null && stableTopicMessagesScrollAnchor.messageId.length > 0) {
      const anchorEl = root.querySelector<HTMLElement>(`[data-topic-message="${cssEscape(stableTopicMessagesScrollAnchor.messageId)}"]`)
      if (anchorEl) {
        newTopicMessagesScrollEl.scrollTop += anchorEl.getBoundingClientRect().top - stableTopicMessagesScrollAnchor.top
      } else if (prevTopicMessagesScrollEl !== null) {
        newTopicMessagesScrollEl.scrollTop = savedTopicMessagesScrollTop
      }
    } else if (prevTopicMessagesScrollEl !== null) {
      newTopicMessagesScrollEl.scrollTop = savedTopicMessagesScrollTop
    } else {
      newTopicMessagesScrollEl.scrollTop = 0
    }
  }
  state.topicMessagesScrollAnchor = null

  const newTopicThreadScrollEl = root.querySelector<HTMLElement>('[data-topic-thread-scroll="1"]')
  if (newTopicThreadScrollEl) {
    if (state.topicThreadRenderReason === 'own-reply') {
      newTopicThreadScrollEl.scrollTop = newTopicThreadScrollEl.scrollHeight
    } else if (state.topicThreadRenderReason === 'live-append') {
      newTopicThreadScrollEl.scrollTop = wasTopicThreadNearBottom
        ? newTopicThreadScrollEl.scrollHeight
        : savedTopicThreadScrollTop
    } else if (state.topicThreadRenderReason === 'initial') {
      newTopicThreadScrollEl.scrollTop = newTopicThreadScrollEl.scrollHeight
    } else if (prevTopicThreadScrollEl !== null) {
      newTopicThreadScrollEl.scrollTop = savedTopicThreadScrollTop
    }
  }

  const newTopicComposerTextEl = root.querySelector<HTMLTextAreaElement>('[data-topics-composer-text="1"]')
  if (newTopicComposerTextEl && wasTopicComposerFocused) {
    newTopicComposerTextEl.focus()
    if (savedTopicComposerSelectionStart !== null && savedTopicComposerSelectionEnd !== null) {
      newTopicComposerTextEl.setSelectionRange(savedTopicComposerSelectionStart, savedTopicComposerSelectionEnd)
    }
  }
  autoGrowTextarea(newTopicComposerTextEl)

  if (wasTopicReplyComposerFocused) {
    const newTopicReplyComposerTextEl = root.querySelector<HTMLTextAreaElement>('[data-topics-reply-composer-text="1"]')
    const newTopicReplyComposerFormEl = newTopicReplyComposerTextEl?.closest<HTMLFormElement>('[data-topics-reply-composer-form="1"]') ?? null
    const newTopicReplyComposerRootId = newTopicReplyComposerFormEl?.dataset.topicsReplyComposerRootId ?? null
    // Restore-ваме САМО ако след render-а все още сме на СЪЩИЯ reply
    // composer (същия rootId) — ако потребителят реално е затворил/сменил
    // thread-а между render-ите, не връщаме focus насила в друг composer.
    if (newTopicReplyComposerTextEl && newTopicReplyComposerRootId !== null && newTopicReplyComposerRootId === savedTopicReplyComposerRootId) {
      newTopicReplyComposerTextEl.focus()
      if (savedTopicReplyComposerSelectionStart !== null && savedTopicReplyComposerSelectionEnd !== null) {
        newTopicReplyComposerTextEl.setSelectionRange(savedTopicReplyComposerSelectionStart, savedTopicReplyComposerSelectionEnd)
      }
    }
  }

  const newAdminSupportMobileListEl = root.querySelector<HTMLElement>('[data-admin-support-mobile-list-scroll="1"]')
  if (newAdminSupportMobileListEl && savedAdminSupportMobileListScrollTop > 0) {
    newAdminSupportMobileListEl.scrollTop = savedAdminSupportMobileListScrollTop
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

  if (wasChatInputFocused) {
    const newChatInputEl = root.querySelector<HTMLInputElement>('[data-lobby-chat-message-input="1"]')
    if (newChatInputEl) {
      newChatInputEl.focus()
      if (savedChatInputSelectionStart !== null && savedChatInputSelectionEnd !== null) {
        newChatInputEl.setSelectionRange(
          savedChatInputSelectionStart,
          savedChatInputSelectionEnd,
          savedChatInputSelectionDirection ?? 'none',
        )
      }
    }
  }

  if (wasLobbyChatInputFocused) {
    const newLobbyChatInputEl = root.querySelector<HTMLInputElement>('[data-lobby-livechat-input="1"]')
    if (newLobbyChatInputEl) {
      newLobbyChatInputEl.focus()
      if (savedLobbyChatInputSelectionStart !== null && savedLobbyChatInputSelectionEnd !== null) {
        newLobbyChatInputEl.setSelectionRange(
          savedLobbyChatInputSelectionStart,
          savedLobbyChatInputSelectionEnd,
          savedLobbyChatInputSelectionDirection ?? 'none',
        )
      }
    }
  }

  const newLobbyChatScrollEl = root.querySelector<HTMLElement>('[data-lobby-livechat-messages-scroll="1"]')
  if (newLobbyChatScrollEl) {
    newLobbyChatScrollEl.scrollTop = wasLobbyChatNearBottom
      ? newLobbyChatScrollEl.scrollHeight
      : savedLobbyChatScrollTop
  }

  if (wasSupportInputFocused) {
    const newSupportInputEl = root.querySelector<HTMLTextAreaElement>('[data-support-send-form="1"] textarea[name="body"]')
    if (newSupportInputEl) {
      if (shouldRestoreSupportInputValue && newSupportInputEl.value !== savedSupportInputValue) {
        newSupportInputEl.value = savedSupportInputValue
      }
      newSupportInputEl.focus()
      newSupportInputEl.scrollTop = savedSupportInputScrollTop
      if (savedSupportInputSelectionStart !== null && savedSupportInputSelectionEnd !== null) {
        newSupportInputEl.setSelectionRange(
          savedSupportInputSelectionStart,
          savedSupportInputSelectionEnd,
          savedSupportInputSelectionDirection ?? 'none',
        )
      }
    }
  }

  const newSupportMessagesScrollEl = root.querySelector<HTMLElement>('#support-popup-messages-scroll')
  if (newSupportMessagesScrollEl) {
    newSupportMessagesScrollEl.scrollTop = wasSupportMessagesNearBottom
      ? newSupportMessagesScrollEl.scrollHeight
      : savedSupportMessagesScrollTop
  }

  if (wasAdminSupportReplyFocused && savedAdminSupportReplyProfileId !== null) {
    const newAdminSupportReplyEl = root.querySelector<HTMLTextAreaElement>(
      `[data-admin-support-reply-form="${cssEscape(savedAdminSupportReplyProfileId)}"] textarea[name="body"]`,
    )
    if (newAdminSupportReplyEl) {
      if (shouldRestoreAdminSupportReplyValue && newAdminSupportReplyEl.value !== savedAdminSupportReplyValue) {
        newAdminSupportReplyEl.value = savedAdminSupportReplyValue
      }
      newAdminSupportReplyEl.focus()
      newAdminSupportReplyEl.scrollTop = savedAdminSupportReplyScrollTop
      if (savedAdminSupportReplySelectionStart !== null && savedAdminSupportReplySelectionEnd !== null) {
        newAdminSupportReplyEl.setSelectionRange(
          savedAdminSupportReplySelectionStart,
          savedAdminSupportReplySelectionEnd,
          savedAdminSupportReplySelectionDirection ?? 'none',
        )
      }
    }
  }

  const newAdminSupportMessagesScrollEl = root.querySelector<HTMLElement>('#support-admin-messages-scroll')
  if (newAdminSupportMessagesScrollEl) {
    newAdminSupportMessagesScrollEl.scrollTop = wasAdminSupportMessagesNearBottom
      ? newAdminSupportMessagesScrollEl.scrollHeight
      : savedAdminSupportMessagesScrollTop
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
      const hasPendingImage = form.dataset.supportHasPendingImage === '1'
      if (body.length > 0 || hasPendingImage) {
        options.onSupportSend(body)
      }
    })

  const supportTextarea = root.querySelector<HTMLTextAreaElement>('[data-support-send-form="1"] textarea[name="body"]')
  submitTextareaOnEnter(supportTextarea)
  supportTextarea
    ?.addEventListener('input', (e) => {
      options.onSupportDraftChange((e.currentTarget as HTMLTextAreaElement).value)
    })
  keepComposerFocusOnPointerSubmit(root.querySelector<HTMLButtonElement>('[data-support-send-form="1"] [data-support-composer-send="1"]'))

  const supportImageInput = root.querySelector<HTMLInputElement>('[data-support-image-input="1"]')
  root.querySelector<HTMLButtonElement>('[data-support-image-pick="1"]')
    ?.addEventListener('click', () => {
      supportImageInput?.click()
    })
  supportImageInput?.addEventListener('change', () => {
    const file = supportImageInput.files?.[0] ?? null
    if (file !== null) {
      options.onSupportImageSelect(file)
    }
    supportImageInput.value = ''
  })
  root.querySelector<HTMLButtonElement>('[data-support-image-remove="1"]')
    ?.addEventListener('click', () => {
      options.onSupportImageRemove()
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
    keepComposerFocusOnPointerSubmit(form.querySelector<HTMLButtonElement>('[data-support-composer-send="1"]'))
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const profileId = form.dataset.adminSupportReplyForm?.trim() ?? ''
      const data = new FormData(form)
      const body = String(data.get('body') ?? '').trim()
      const hasPendingImage = form.dataset.adminSupportHasPendingImage === '1'
      if (profileId && (body.length > 0 || hasPendingImage)) {
        options.onAdminSupportReply(profileId, body)
      }
    })

    const profileId = form.dataset.adminSupportReplyForm?.trim() ?? ''
    const adminTextarea = form.querySelector<HTMLTextAreaElement>('textarea[name="body"]')
    submitTextareaOnEnter(adminTextarea)
    adminTextarea?.addEventListener('input', (e) => {
      if (profileId) {
        options.onAdminSupportReplyDraftChange(profileId, (e.currentTarget as HTMLTextAreaElement).value)
      }
    })
  })

  root.querySelectorAll<HTMLInputElement>('[data-admin-support-image-input]').forEach((input) => {
    input.addEventListener('change', () => {
      const profileId = input.dataset.adminSupportImageInput?.trim() ?? ''
      const file = input.files?.[0] ?? null
      if (profileId && file !== null) {
        options.onAdminSupportImageSelect(profileId, file)
      }
      input.value = ''
    })
  })
  root.querySelectorAll<HTMLButtonElement>('[data-admin-support-image-pick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const profileId = btn.dataset.adminSupportImagePick?.trim() ?? ''
      if (!profileId) return
      root.querySelector<HTMLInputElement>(`[data-admin-support-image-input="${cssEscape(profileId)}"]`)?.click()
    })
  })
  root.querySelectorAll<HTMLButtonElement>('[data-admin-support-image-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const profileId = btn.dataset.adminSupportImageRemove?.trim() ?? ''
      if (profileId) options.onAdminSupportImageRemove(profileId)
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

  root.querySelector<HTMLButtonElement>('[data-admin-support-mobile-back="1"]')
    ?.addEventListener('click', () => options.onAdminSupportMobileBack())

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

  attachAdminTournamentsHandlers(root, {
    onBack: () => { options.onAdminTournamentsBack?.() },
    onFilter: (filters) => { options.onAdminTournamentsFilter?.(filters) },
    onPage: (page) => { options.onAdminTournamentsPage?.(page) },
    onOpen: (tournamentId) => { options.onAdminTournamentOpen?.(tournamentId) },
    onReconcile: () => { options.onAdminTournamentReconcile?.() },
    onCancelOpen: () => { options.onAdminTournamentCancelOpen?.() },
    onCancelConfirm: () => { options.onAdminTournamentCancelConfirm?.() },
    onCancelDismiss: () => { options.onAdminTournamentCancelDismiss?.() },
  })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-payments-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.adminPaymentsOpen ?? 'today'
      options.onAdminPaymentsOpen?.(p as AdminPaymentPeriod)
    })
  })

  const chatScroll = root.querySelector<HTMLElement>('[data-chat-messages-scroll="1"]')
  if (chatScroll) {
    chatScroll.scrollTop = wasChatMessagesNearBottom
      ? chatScroll.scrollHeight
      : savedChatMessagesScrollTop
  }
}
