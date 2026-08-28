import 'dotenv/config'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

sharp.block({
  operation: [
    'VipsForeignLoadNsgif',
    'VipsForeignLoadTiff',
    'VipsForeignLoadVips',
  ],
})

import Stripe from 'stripe'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { createActiveRoomSnapshotStore } from './db/activeRoomSnapshotStore.js'
import { createPrivateRoomMatchStore, type PrivateRoomMatchOccupant, type PrivateRoomMatchRecord } from './db/privateRoomMatchStore.js'
import { dbDateToUtc } from './db/dbDate.js'
import { createAdminSettingsStore } from './db/adminSettingsStore.js'
import {
  createAuthStore,
  createClearSessionCookieHeader,
  createSessionCookieHeader,
  getSessionTokenFromCookieHeader,
  isAdminOrSubadminSession,
  isFullAdminSession,
  isLafcheMessageDeleteModeratorSession,
  isLafcheModeratorSession,
  isPikaAnnouncementAuthorSession,
  isPikaTeamGiftFriendshipBypassSession,
  isPikaTeamGiftMaxAmountSession,
  isPikaTeamSupportChatSession,
  isTopicMessageModeratorSession,
  isTopicModeratorSession,
  isTopicWholeTopicModeratorSession,
  type AuthSessionSnapshot,
} from './db/authStore.js'
import { createChatStore } from './db/chatStore.js'
import { createLobbyChatStore } from './db/lobbyChatStore.js'
import { createTopicStore, type TopicSnapshot } from './db/topicStore.js'
import { createTopicMessageStore, type TopicMessageSnapshot, type TopicMessageDeletionEvent } from './db/topicMessageStore.js'
import { createTopicReadStateStore } from './db/topicReadStateStore.js'
import {
  createTopicModerationStore,
  type TopicModeratorRole,
  type TopicModerationAction,
  type TopicMuteEvidenceSourceKind,
  type TopicMuteEvidenceReasonCategory,
} from './db/topicModerationStore.js'
import {
  validateLobbyChatBody,
  countUnicodeCodePoints,
  LOBBY_CHAT_MAX_BODY_CODE_POINTS,
} from './protocol/lobbyChatValidation.js'
import { validateTopicMessageBody, TOPIC_MESSAGE_MAX_BODY_CODE_POINTS } from './protocol/topicMessageValidation.js'
import { computeTopicMessagePollAdvance } from './realtime/topicMessagePollAdvance.js'
import {
  validatePrivateRoomChatBody,
  PRIVATE_ROOM_CHAT_MAX_BODY_CODE_POINTS,
} from './protocol/privateRoomChatValidation.js'
import { createSupportStore, type SupportMessageSnapshot, type SupportConversationSnapshot } from './db/supportStore.js'
import { createGuestContactStore } from './db/guestContactStore.js'
import {
  createGuestTrialStore,
  createGuestIdCookieHeader,
  getGuestIdFromCookieHeader,
  hashGuestIdentitySignal,
  GUEST_TRIAL_MAX_GAMES,
  GUEST_TRIAL_STAKE,
} from './db/guestTrialStore.js'
import {
  decodeImageAttachmentDataUrl,
  deleteAttachmentFileByFilename,
  IMAGE_ATTACHMENT_FILENAME_PATTERN,
  MAX_IMAGE_ATTACHMENT_INPUT_BYTES,
  MAX_IMAGE_ATTACHMENT_JSON_BYTES,
  processImageAttachmentToWebp,
  writeWebpAttachmentFile,
} from './uploads/imageAttachments.js'
import {
  createCoinPackageStore,
  type CoinPackageStatus,
} from './db/coinPackageStore.js'
import { createBlockStore, BLOCK_LIMIT } from './db/blockStore.js'
import { createLikeStore } from './db/likeStore.js'
import { createMissionStore, type MissionType } from './db/missionStore.js'
import {
  createCoinPurchaseStore,
  ADMIN_PAYMENT_PERIODS,
  type AdminPaymentStats,
  type PaymentPeriodStats,
  type AdminPaymentListRow,
} from './db/coinPurchaseStore.js'
import { createDailyRewardsStore } from './db/dailyRewardsStore.js'
import {
  createSiteVisitStore,
  type SiteVisitNavigationType,
  type SiteVisitUtmParams,
  type SiteVisitViewLayout,
  type VisitorDeviceFilter,
  type VisitorOsFilter,
} from './db/siteVisitStore.js'
import { detectDeviceType } from './utils/detectDeviceType.js'
import { detectOsType } from './utils/detectOsType.js'
import { ensureServerDatabaseReady } from './db/ensureServerDatabaseReady.js'
import { createFriendshipStore } from './db/friendshipStore.js'
import { createTournamentStore } from './db/tournamentStore.js'
import { createTournamentEconomyStore } from './db/tournamentEconomyStore.js'
import { createTournamentBetaAccessStore } from './db/tournamentBetaAccessStore.js'
import { isLocalTournamentTestModeEnabled } from './localTournamentTest/localTournamentTestModeGuard.js'
import { createLocalTournamentTestService } from './localTournamentTest/localTournamentTestService.js'
import { handleLocalTournamentTestRequest } from './localTournamentTest/handleLocalTournamentTestRequest.js'
import {
  TOURNAMENT_STATUSES,
  getTournamentRoundLadder,
  type TournamentEntryStatus,
  type TournamentPartnerInviteRecord,
  type TournamentRecord,
  type TournamentRoundType,
} from './tournament/tournamentTypes.js'
import {
  ALLOWED_TOURNAMENT_ENTRY_FEES,
  ALLOWED_TOURNAMENT_TEAM_CAPACITIES,
  isAllowedTournamentEntryFee,
  isAllowedTournamentTeamCapacity,
  isValidTournamentStartMode,
  isValidTournamentVisibility,
  validateTournamentName,
  validateTournamentPassword,
  validateTournamentScheduledStartAt,
} from './tournament/tournamentValidation.js'
import {
  ACTIVE_TOURNAMENT_STATUSES,
  buildTournamentRoundDtos,
  buildTeamDtos,
  toTournamentPartnerInviteDto,
  toTournamentDetailDto,
  toTournamentSummaryDto,
  type TournamentPartnerCandidateDto,
  type TournamentSummaryDto,
} from './tournament/tournamentDto.js'
import {
  createTournamentScheduler,
  type TournamentScheduler,
} from './tournament/tournamentScheduler.js'
import {
  createTournamentCoordinator,
  type TournamentCoordinator,
  type TournamentMatchAssignment,
} from './tournament/tournamentCoordinator.js'
import {
  createTournamentAdminStore,
  type TournamentIntegrityState,
} from './tournament/tournamentAdmin.js'
import { createPasswordHash, verifyPassword } from './db/authHelpers.js'
import { importBotProfilesCatalog } from './db/importBotProfilesCatalog.js'
import { createMatchEconomyStore, setMatchPrizeResolver } from './db/matchEconomyStore.js'
import { createMatchRoomsStore } from './db/matchRoomsStore.js'
import { createVipStore, type VipInterval } from './db/vipStore.js'
import {
  createVipPurchaseStore,
  VIP_PACKAGE_CATALOG,
  isVipPackageId,
  type VipPackageId,
} from './db/vipPurchaseStore.js'
import { normalizeProfileSearchTerm } from './db/normalizeProfileIdentityText.js'
import {
  computePlayersPageOrder,
  generatePlayersPageSeed,
} from './db/computePlayersPageOrder.js'
import { createPlayersPageSnapshotStore } from './db/playersPageSnapshotStore.js'
import { createPlayerProgressStore } from './db/playerProgressStore.js'
import { createTableExitPenaltyStore } from './db/tableExitPenaltyStore.js'
import { createYellowCoinGiftStore, type YellowCoinGiftSnapshot } from './db/yellowCoinGiftStore.js'
import { attachConnectionToRoomSeat } from './core/attachConnectionToRoomSeat.js'
import { broadcastRoomSnapshots, setBroadcastRoomSnapshotsMonitoringHook } from './core/broadcastRoomSnapshots.js'
import { countServerRoomsByPhase } from './core/countServerRoomsByPhase.js'
import { computeActiveRoomsSnapshot } from './core/computeActiveRoomsSnapshot.js'
import { createInitialServerState } from './core/createInitialServerState.js'
import { createServerConnection } from './core/createServerConnection.js'
import { detachConnectionFromRoomSeat } from './core/detachConnectionFromRoomSeat.js'
import { detachConnectionsBoundToRoom } from './core/detachConnectionsBoundToRoom.js'
import { findHumanParticipantByConnectionId } from './core/findHumanParticipantByConnectionId.js'
import { findParticipantSeat } from './core/findParticipantSeat.js'
import { getConnectionById } from './core/getConnectionById.js'
import { handleCreateRoom } from './core/handleCreateRoom.js'
import { handleDisconnect } from './core/handleDisconnect.js'
import { handleJoinRoom } from './core/handleJoinRoom.js'
import { markHumanParticipantDisconnected } from './core/markHumanParticipantDisconnected.js'
import { rawDataToText } from './core/rawDataToText.js'
import { sendJsonMessage } from './core/sendJsonMessage.js'
import type {
  ConnectionId,
  PlayerPublicProfileSnapshot,
  RoomParticipant,
  Seat,
  ServerRoom,
  ServerState,
  Team,
} from './core/serverTypes.js'
import { SERVER_SEAT_ORDER } from './core/serverTypes.js'
import {
  createReconnectedHumanParticipant,
  findHumanParticipantByReconnectToken,
  type ServerGameRuntime,
  shouldKeepRoomAlive,
} from './core/serverGameRuntimeHelpers.js'
import { updateConnectionHeartbeat } from './core/updateConnectionHeartbeat.js'
import { updateHumanParticipantInRoom } from './core/updateHumanParticipantInRoom.js'
import { updateServerConnectionInState } from './core/updateServerConnectionInState.js'
import { updateServerRoomInState } from './core/updateServerRoomInState.js'
import { upsertServerConnection } from './core/upsertServerConnection.js'
import { upsertServerRoom } from './core/upsertServerRoom.js'
import { addQueueEntry } from './matchmaking/addQueueEntry.js'
import { createInitialMatchmakingState } from './matchmaking/createInitialMatchmakingState.js'
import { createMatchmakingQueueEntry } from './matchmaking/createMatchmakingQueueEntry.js'
import { getQueueEntryByConnectionId } from './matchmaking/getQueueEntryByConnectionId.js'
import { getSearchingEntriesByStake } from './matchmaking/getSearchingEntriesByStake.js'
import { isQueueEntryExpired } from './matchmaking/isQueueEntryExpired.js'
import type { MatchmakingState } from './matchmaking/matchmakingState.js'
import {
  MATCHMAKING_WAIT_MS,
  SUPPORTED_MATCH_STAKES,
  setSupportedMatchStakes,
  type MatchStake,
  type MatchmakingQueueEntry,
} from './matchmaking/matchmakingTypes.js'
import { removeQueueEntryByConnectionId } from './matchmaking/removeQueueEntryByConnectionId.js'
import {
  createMatchmakingBotSelectionSeed,
  selectMatchmakingBotProfiles,
} from './matchmaking/selectMatchmakingBotProfiles.js'
import { tryCreatePendingMatchGroup } from './matchmaking/tryCreatePendingMatchGroup.js'
import { createInProcessActiveRoomRuntime } from './game/createInProcessActiveRoomRuntime.js'
import { createInProcessGameWorkerManager } from './game/createInProcessGameWorkerManager.js'
import { createWorkerBackedActiveRoomRuntime } from './game/createWorkerBackedActiveRoomRuntime.js'
import { initializeRoomAuthoritativeGameState } from './game/initializeRoomAuthoritativeGameState.js'
import { rebaseServerStateToEventAt } from './game/rebaseServerStateToEventAt.js'
import type { ServerAuthoritativeGameState } from './game/serverGameTypes.js'
import {
  createGameWorkerLifecycleClient,
  type GameWorkerLifecycleClient,
  type GameWorkerLifecycleHealth,
} from './game/createGameWorkerLifecycleClient.js'
import {
  createGameWorkerPool,
  type GameWorkerPool,
} from './game/createGameWorkerPool.js'
import {
  createGameWorkerTickOrchestrator,
  type GameWorkerTickOrchestrator,
} from './game/createGameWorkerTickOrchestrator.js'
import { applyAcceptedGameWorkerCandidate } from './game/applyAcceptedGameWorkerCandidate.js'
import type {
  GameWorkerManager,
  GameWorkerManagerHealth,
  GameWorkerSnapshot,
} from './game/gameWorkerManager.js'
import { createRoomRevisionRegistry } from './game/createRoomRevisionRegistry.js'
import {
  createRoomShadowSynchronizer,
  type RoomShadowSynchronizer,
} from './game/createRoomShadowSynchronizer.js'
import { resolveGameWorkerEntryUrl } from './game/resolveGameWorkerEntryUrl.js'
import { parseClientMessage } from './protocol/parseClientMessage.js'
import type {
  LobbyChatErrorCode,
  PrivateRoomChatErrorCode,
  TopicMessageErrorCode,
  TopicMessageBroadcastSnapshot,
  TopicReplyBroadcastSnapshot,
  TopicReplyErrorCode,
  TopicMessageLikeErrorCode,
  TopicCreateErrorCode,
} from './protocol/messageTypes.js'
import { validateTopicTitle, TOPIC_TITLE_MAX_CODE_POINTS } from './protocol/topicTitleValidation.js'
import { createPrivateRoomsStore, getHumanCount, getTeamSlots } from './game/privateRoomsStore.js'
import type {
  PrivateRoom,
  PrivateRoomHumanOccupant,
  PrivateRoomBotOccupant,
  PrivateRoomSlot,
  RoomReadiness,
} from './game/privateRoomsStore.js'
import { mapPrivateRoomSlotToSeat } from './game/mapPrivateRoomSlotToSeat.js'
import { createPrivateRoomChatStore, PRIVATE_ROOM_CHAT_HISTORY_LIMIT } from './game/privateRoomChatStore.js'
import { createGuestTrialRoom } from './core/createGuestTrialRoom.js'
import { createServerRoom } from './core/createServerRoom.js'
import { createHumanParticipant } from './core/createHumanParticipant.js'
import { createBotParticipant } from './core/createBotParticipant.js'
import { seatParticipantInRoom } from './core/seatParticipantInRoom.js'
import { updateRoomHostPlayerId } from './core/updateRoomHostPlayerId.js'
import type {
  ClientMessage,
  PrivateRoomSnapshot,
  PrivateGamesListMessage,
  PrivateGameScoreUpdatedMessage,
  PrivateRoomMatchSnapshot,
} from './protocol/messageTypes.js'
import { validateGuestContactPayload } from './contact/guestContactValidation.js'
import { sendGuestContactEmail } from './contact/sendGuestContactEmail.js'
import { createPasswordResetStore, type PasswordResetStore } from './db/passwordResetStore.js'
import { handleForgotPassword, handleResetPassword, type PasswordResetHandlerContext } from './auth/passwordResetHandlers.js'
import { createMonitoringSampler } from './monitoring/createMonitoringSampler.js'
import type { MonitoringSampler } from './monitoring/monitoringTypes.js'
import { countOpenWebSockets, countUniqueOnlineRealPlayers } from './monitoring/monitoringHelpers.js'
import { buildWsConnectionsDiagnostic } from './monitoring/wsConnectionsHelper.js'
import { sanitizeErrorMessage } from './monitoring/systemMetrics.js'
import {
  createMonitoringHistoryStore,
  getDefaultRetentionCutoffMs,
  isValidHistoryWindow,
  type MonitoringHistoryStore,
} from './monitoring/monitoringHistoryStore.js'
import { createActivityCounters, type ActivityCounters } from './monitoring/activityCounters.js'
import { classifyHttpRequestPath } from './monitoring/httpCategoryClassifier.js'
import { createEventLoopMonitor } from './monitoring/eventLoopHealth.js'
import {
  createForensicRingBuffer,
  createBucketAccumulator,
  createCpuIncidentDetector,
  type ForensicRingBuffer,
  type BucketAccumulator,
  type CpuIncidentDetector,
} from './monitoring/cpuIncidentDetector.js'
import { CPU_INCIDENT_SAMPLING, CPU_INCIDENT_THRESHOLDS, type SpikeContext } from './monitoring/cpuIncidentTypes.js'
import {
  createCpuIncidentStore,
  getDefaultSummaryRetentionCutoffMs,
  getDefaultTimelineRetentionCutoffMs,
  type CpuIncidentStore,
} from './monitoring/cpuIncidentStore.js'
import { createBackgroundJobMetrics, type BackgroundJobMetrics } from './monitoring/backgroundJobMetrics.js'
import { createGcMetrics, type GcMetrics } from './monitoring/gcMetrics.js'
import { setSendJsonMessageMonitoringHook } from './core/sendJsonMessage.js'
import { resumeCoinPurchaseCheckout } from './shop/resumeCoinPurchaseCheckout.js'
import { hideCoinPurchase } from './shop/hideCoinPurchase.js'
import { createTrainingRecorder } from './trainingRecorder/trainingRecorder.js'
import {
  handleTrainingRecorderOnApplied,
  handleTrainingRecorderHumanBid,
  handleTrainingRecorderHumanCard,
} from './trainingRecorder/trainingRecorderHooks.js'
import type { TrainingRecorderMetrics } from './trainingRecorder/trainingRecorderMetrics.js'
import {
  logAcceptedCardPlayAudit,
  logRejectedGameplayAction,
} from './game/logGameplayActionAudit.js'

const trainingRecorder = createTrainingRecorder('0')

const HOST = '0.0.0.0'
const PORT = Number(process.env.PORT ?? 3001)
const MATCHMAKING_TICK_MS = 250
const EARLY_BOT_FILL_DEBIT_MS = 1700
const MATCHMAKING_NO_CAPACITY_COOLDOWN_MS = 2_000
const GAME_RUNTIME_TICK_MS = 250
const GAME_WORKER_TICK_FAILURE_LOG_INTERVAL_MS = 5_000
const MATCH_PLAYERS_REQUIRED = 4
const MAX_JSON_BODY_BYTES = 15_000_000
const GUEST_CONTACT_MAX_JSON_BODY_BYTES = 20_000
const GUEST_CONTACT_RATE_LIMIT_WINDOW_MS = 30 * 60 * 1000
const GUEST_CONTACT_RATE_LIMIT_MAX_MESSAGES = 3
const MAX_PROFILE_GALLERY_IMAGES = 6
const UPLOADS_ROUTE_PREFIX = '/uploads/'
const SERVER_ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPLOADS_ROOT_PATH = join(SERVER_ROOT_PATH, 'uploads')
const AVATAR_UPLOADS_PATH = join(UPLOADS_ROOT_PATH, 'avatars')
const GALLERY_UPLOADS_PATH = join(UPLOADS_ROOT_PATH, 'profile-gallery')

// Личен чат — снимки. Отделна upload директория, НЕ сервирана от публичния
// handleUploadsRequest (виж handleChatAttachmentRequest) — снимките в
// чата са лично съдържание между двама конкретни потребители, за разлика
// от avatar/gallery, които са умишлено публични.
const CHAT_ATTACHMENT_UPLOADS_PATH = join(UPLOADS_ROOT_PATH, 'chat-attachments')
const SUPPORT_ATTACHMENT_UPLOADS_PATH = join(UPLOADS_ROOT_PATH, 'support-attachments')
// "Теми" — снимки към root съобщения/replies. Protected, СЪЩИЯТ модел като
// chat/support (НЕ в PUBLIC_UPLOAD_SUBDIRECTORY_ROOTS по-долу) — Topics е
// registered-only четене, а не публично достъпно съдържание.
const TOPIC_ATTACHMENT_UPLOADS_PATH = join(UPLOADS_ROOT_PATH, 'topic-attachments')
// Lafche retention hotfix — protected, moderation-ONLY evidence image copies
// (виж 20260818_005_add_topic_mute_evidence_attachment_copy.sql). Отделна
// директория от TOPIC_ATTACHMENT_UPLOADS_PATH нарочно: normal Lafche
// attachment cleanup (enqueueAttachmentDeletion) никога не пипа тази папка,
// значи hard-delete на source поста не може случайно да premahne evidence
// копие, което живее тук. НЕ е в PUBLIC_UPLOAD_SUBDIRECTORY_ROOTS — served
// изключително през handleTopicMuteEvidenceAttachmentDownloadRequest
// (moderator-only auth), никога през generic uploads route.
const TOPIC_MUTE_EVIDENCE_ATTACHMENT_UPLOADS_PATH = join(UPLOADS_ROOT_PATH, 'topic-mute-evidence-attachments')
// base64 data URL overhead е ~33% над бинарния размер; 10MB оригинал →
// ~13.3MB base64 текст. 15MB праг покрива това с марж, съгласувано с
// MAX_JSON_BODY_BYTES, ползван за profile avatar/gallery endpoint-ите.
// Колко pending deletion записа обработва background cleanup job-ът на
// един цикъл — ограничава worst-case I/O натоварването на един tick.
const CHAT_ATTACHMENT_CLEANUP_BATCH_SIZE = 200
const CHAT_ATTACHMENT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000
const CHAT_ATTACHMENT_CLEANUP_STARTUP_DELAY_MS = 30_000
// Orphan scan е по-рядък и по-скъп (directory listing + DB lookup за всеки
// файл) — grace period предпазва in-flight upload-и (файлът вече е записан
// на диск, но DB транзакцията все още не е committed) от преждевременно
// изтриване.
const CHAT_ATTACHMENT_ORPHAN_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000
const CHAT_ATTACHMENT_ORPHAN_SCAN_STARTUP_DELAY_MS = 90_000
const CHAT_ATTACHMENT_ORPHAN_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000
// Колко дни пазим завършени ('done') deletion-queue редове преди purge —
// достатъчно дълго за post-hoc debugging, но предпазва
// friend_chat_attachment_deletions от неограничен растеж (виж
// purgeDoneAttachmentDeletions, извикван от runChatAttachmentOrphanScan).
const CHAT_ATTACHMENT_DELETION_EVENT_RETENTION_DAYS = 7
const SUPPORT_ATTACHMENT_CLEANUP_BATCH_SIZE = CHAT_ATTACHMENT_CLEANUP_BATCH_SIZE
const SUPPORT_ATTACHMENT_CLEANUP_INTERVAL_MS = CHAT_ATTACHMENT_CLEANUP_INTERVAL_MS
const SUPPORT_ATTACHMENT_CLEANUP_STARTUP_DELAY_MS = 45_000
const SUPPORT_ATTACHMENT_ORPHAN_SCAN_INTERVAL_MS = CHAT_ATTACHMENT_ORPHAN_SCAN_INTERVAL_MS
const SUPPORT_ATTACHMENT_ORPHAN_SCAN_STARTUP_DELAY_MS = 120_000
const SUPPORT_ATTACHMENT_ORPHAN_GRACE_PERIOD_MS = CHAT_ATTACHMENT_ORPHAN_GRACE_PERIOD_MS
const SUPPORT_ATTACHMENT_DELETION_EVENT_RETENTION_DAYS = CHAT_ATTACHMENT_DELETION_EVENT_RETENTION_DAYS
// "Теми" attachment cleanup — трети независим job чифт, изместени startup
// delay-и (60s/150s) спрямо chat (30s/90s) и support (45s/120s), за да не се
// засичат в момента на server startup.
const TOPIC_ATTACHMENT_CLEANUP_BATCH_SIZE = CHAT_ATTACHMENT_CLEANUP_BATCH_SIZE
const TOPIC_ATTACHMENT_CLEANUP_INTERVAL_MS = CHAT_ATTACHMENT_CLEANUP_INTERVAL_MS
const TOPIC_ATTACHMENT_CLEANUP_STARTUP_DELAY_MS = 60_000
const TOPIC_ATTACHMENT_ORPHAN_SCAN_INTERVAL_MS = CHAT_ATTACHMENT_ORPHAN_SCAN_INTERVAL_MS
const TOPIC_ATTACHMENT_ORPHAN_SCAN_STARTUP_DELAY_MS = 150_000
const TOPIC_ATTACHMENT_ORPHAN_GRACE_PERIOD_MS = CHAT_ATTACHMENT_ORPHAN_GRACE_PERIOD_MS
const TOPIC_ATTACHMENT_DELETION_EVENT_RETENTION_DAYS = CHAT_ATTACHMENT_DELETION_EVENT_RETENTION_DAYS
const guestContactRateLimitByIp = new Map<string, { windowStartedAt: number; count: number }>()

type GameWorkerTickMode = 'in-process' | 'worker-candidate'

function parseGameWorkerTickMode(value: string | undefined): GameWorkerTickMode {
  if (value === undefined || value.trim() === '') {
    return 'in-process'
  }

  if (value === 'in-process' || value === 'worker-candidate') {
    return value
  }

  throw new Error(
    `[startup] Invalid BELOT_GAME_WORKER_TICK_MODE=${JSON.stringify(value)}. ` +
      'Expected "in-process" or "worker-candidate".',
  )
}

function parsePositiveIntegerEnv(
  envName: string,
  value: string | undefined,
  defaultValue: number,
): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue
  }

  const parsed = Number(value)

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `[startup] Invalid ${envName}=${JSON.stringify(value)}. Expected a positive integer.`,
    )
  }

  return parsed
}

const gameWorkerTickMode = parseGameWorkerTickMode(
  process.env.BELOT_GAME_WORKER_TICK_MODE,
)
const gameWorkerPoolWorkerCount =
  gameWorkerTickMode === 'worker-candidate'
    ? parsePositiveIntegerEnv(
        'BELOT_GAME_WORKER_COUNT',
        process.env.BELOT_GAME_WORKER_COUNT,
        1,
      )
    : 1
const gameWorkerPoolMaxRoomsPerWorker =
  gameWorkerTickMode === 'worker-candidate'
    ? parsePositiveIntegerEnv(
        'BELOT_GAME_WORKER_MAX_ROOMS_PER_WORKER',
        process.env.BELOT_GAME_WORKER_MAX_ROOMS_PER_WORKER,
        1000,
      )
    : 1000
const backendStartedAtMs = Date.now()
let monitoringSampler: MonitoringSampler | null = null
let monitoringHistoryStore: MonitoringHistoryStore | null = null
let monitoringHistoryIntervalId: ReturnType<typeof setInterval> | null = null
let monitoringHistoryPurgeIntervalId: ReturnType<typeof setInterval> | null = null

// ─── CPU incident forensics (отделен слой, не пипа monitoring_history) ────────
const activityCounters: ActivityCounters = createActivityCounters()
const eventLoopMonitor = createEventLoopMonitor()
const cpuForensicRingBuffer: ForensicRingBuffer = createForensicRingBuffer()
const cpuBucketAccumulator: BucketAccumulator = createBucketAccumulator()
const cpuIncidentDetector: CpuIncidentDetector = createCpuIncidentDetector()
// Diagnostic fix (виж forensic audit) — bounded background job timing и GC
// forensic metrics, четени само в extreme-spike snapshot-а по-долу.
const backgroundJobMetrics: BackgroundJobMetrics = createBackgroundJobMetrics()
const gcMetrics: GcMetrics = createGcMetrics()
let cpuIncidentStore: CpuIncidentStore | null = null
let cpuForensicBucketIntervalId: ReturnType<typeof setInterval> | null = null
let cpuForensicSampleIntervalId: ReturnType<typeof setInterval> | null = null
let cpuIncidentPurgeIntervalId: ReturnType<typeof setInterval> | null = null

let isServerShuttingDown = false
let lastGameWorkerTickFailureLogAt = 0
let catalogBotRefillInterval: ReturnType<typeof setInterval> | null = null
let supportCleanupInterval: ReturnType<typeof setInterval> | null = null
let siteVisitRetentionInterval: ReturnType<typeof setInterval> | null = null
let siteVisitRetentionStartupTimeout: ReturnType<typeof setTimeout> | null = null
let missionRotationTimeout: ReturnType<typeof setTimeout> | null = null
const SITE_VISIT_RETENTION_DAYS = 90
const SITE_VISIT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000
const SITE_VISIT_RETENTION_STARTUP_DELAY_MS = 30 * 1000

function logGameWorkerTickFailure(message: string): void {
  const now = Date.now()
  if (
    lastGameWorkerTickFailureLogAt !== 0 &&
    now - lastGameWorkerTickFailureLogAt < GAME_WORKER_TICK_FAILURE_LOG_INTERVAL_MS
  ) {
    return
  }

  lastGameWorkerTickFailureLogAt = now
  console.error(`[game-worker-tick] ${message}`)
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function runMatchCompletionSideEffect(
  label: string,
  roomId: string,
  effect: () => void,
): boolean {
  try {
    effect()
    return true
  } catch (error) {
    console.error(
      `[game-worker-tick] Completion side effect failed label=${label} roomId=${roomId}: ${formatErrorMessage(error)}`,
    )
    return false
  }
}

function isShutdownGuardedClientMessage(message: ClientMessage): boolean {
  switch (message.type) {
    case 'create_room':
    case 'join_room':
    case 'join_matchmaking':
    case 'join_guest_trial':
    case 'leave_matchmaking':
    case 'resume_room':
    case 'leave_active_room':
    case 'submit_bid_action':
    case 'submit_cut_index':
    case 'submit_play_card':
    case 'resume_human_control':
    case 'submit_partner_rating':
    case 'request_replay':
    case 'request_leave_match':
    case 'create_private_room':
    case 'join_private_room':
    case 'leave_private_room':
    case 'invite_to_private_room':
    case 'cancel_private_room_invite':
    case 'respond_private_room_invite':
    case 'request_private_rooms_list':
    case 'request_private_games_list':
    case 'add_bot_to_private_room_team':
    case 'remove_bot_from_private_room_team':
    case 'start_private_room':
    case 'kick_from_private_room':
    case 'tournament_semifinal_result_acknowledge':
    case 'subscribe_private_room_chat':
    case 'unsubscribe_private_room_chat':
    case 'send_private_room_chat_message':
    case 'subscribe_lobby_chat':
    case 'unsubscribe_lobby_chat':
    case 'send_lobby_chat_message':
    case 'subscribe_topic_messages':
    case 'unsubscribe_topic_messages':
    case 'send_topic_message':
    case 'send_topic_reply':
    case 'toggle_topic_message_like':
    case 'create_topic':
    case 'subscribe_topics_directory':
    case 'unsubscribe_topics_directory':
      return true
    case 'ping':
    case 'request_player_profile':
    case 'send_emoji_reaction':
    case 'send_phrase_reaction':
      return false
  }

  const exhaustiveCheck: never = message
  return exhaustiveCheck
}

if (isLocalTournamentTestModeEnabled()) {
  console.log('[local-tournament-test] enabled')
}

const databaseBootstrap = await ensureServerDatabaseReady()
if (isLocalTournamentTestModeEnabled()) {
  console.log(`[local-tournament-test] database file: ${databaseBootstrap.databaseFilePath}`)
}
const botCatalogImport = await importBotProfilesCatalog(
  databaseBootstrap.databaseFilePath,
)
const activeRoomSnapshotStore = await createActiveRoomSnapshotStore(
  databaseBootstrap.databaseFilePath,
)
const privateRoomMatchStore = await createPrivateRoomMatchStore(
  databaseBootstrap.databaseFilePath,
)
const playerProgressStore = await createPlayerProgressStore(
  databaseBootstrap.databaseFilePath,
)
const likeStore = await createLikeStore(databaseBootstrap.databaseFilePath)
const blockStore = await createBlockStore(databaseBootstrap.databaseFilePath)
const playersPageSnapshotStore = createPlayersPageSnapshotStore()
playerProgressStore.seedCatalogBotsIfNeeded()
catalogBotRefillInterval = setInterval(() => {
  if (isServerShuttingDown) {
    return
  }

  playerProgressStore.refillCatalogBotWallets()
}, 5 * 60 * 1000)

const cleanedUpTempBots = playerProgressStore.cleanupAllTemporaryBotProfiles()
if (cleanedUpTempBots > 0) {
  console.log(`[startup] Cleaned up ${cleanedUpTempBots} leftover temporary bot profile(s) from previous session.`)
}
const adminSettingsStore = await createAdminSettingsStore(
  databaseBootstrap.databaseFilePath,
)
const coinPackageStore = await createCoinPackageStore(
  databaseBootstrap.databaseFilePath,
)
const coinPurchaseStore = await createCoinPurchaseStore(
  databaseBootstrap.databaseFilePath,
)
const dailyRewardsStore = await createDailyRewardsStore(
  databaseBootstrap.databaseFilePath,
)
const authStore = await createAuthStore(
  databaseBootstrap.databaseFilePath,
  playerProgressStore,
  {
    getSignupBonusYellowCoins: () =>
      adminSettingsStore.getSettings().signupBonusYellowCoins,
  },
)
const friendshipStore = await createFriendshipStore(
  databaseBootstrap.databaseFilePath,
  playerProgressStore,
)
const tournamentStore = await createTournamentStore(databaseBootstrap.databaseFilePath)
const tournamentEconomyStore = await createTournamentEconomyStore(databaseBootstrap.databaseFilePath)
const tournamentBetaAccessStore = await createTournamentBetaAccessStore(databaseBootstrap.databaseFilePath)
// Конструираме я безусловно (евтино — само затваря deps), но всеки заявка
// към нея минава първо през isLocalTournamentTestRequestAllowed (виж
// handleLocalTournamentTestRequest.ts) — извън strictly-local режима е
// напълно неактивна.
const localTournamentTestService = createLocalTournamentTestService({
  databaseFilePath: databaseBootstrap.databaseFilePath,
  tournamentStore,
  tournamentEconomyStore,
  authStore,
  refillCatalogBotWallets: () => playerProgressStore.refillCatalogBotWallets(),
  removeTournamentRoomIfPresent: (roomId) => forceRemoveTournamentRoomById(roomId),
})
let tournamentScheduler: TournamentScheduler | null = null
let tournamentCoordinator: TournamentCoordinator | null = null
const tournamentAdminStore = await createTournamentAdminStore({
  databaseFilePath: databaseBootstrap.databaseFilePath,
  getPublicProfile: (profileId) => playerProgressStore.getPublicProfile(profileId),
  getCoordinatorHealth: () => tournamentCoordinator?.getHealth() ?? null,
  getSchedulerHealth: () => tournamentScheduler?.getHealth() ?? null,
  runCoordinatorTick: () => tournamentCoordinator?.tickNow(),
})
const chatStore = await createChatStore(
  databaseBootstrap.databaseFilePath,
  playerProgressStore,
  blockStore,
  friendshipStore,
  {
    vipStatusChecker: {
      isActiveVip: (profileId) => vipStore.getStatus(profileId).isActive,
    },
  },
)
const lobbyChatStore = await createLobbyChatStore(databaseBootstrap.databaseFilePath)
const topicStore = await createTopicStore(databaseBootstrap.databaseFilePath)
const topicMessageStore = await createTopicMessageStore(databaseBootstrap.databaseFilePath)
const topicReadStateStore = await createTopicReadStateStore(databaseBootstrap.databaseFilePath)
const topicModerationStore = await createTopicModerationStore(databaseBootstrap.databaseFilePath)

// ─── Общ лайв чат в лобито (broadcast към абонирани connection-и) ───────────
//
// Няколко PM2 процеса споделят една SQLite база (WAL) — всеки процес пази
// СВОЯ собствена socketRegistry/serverState.connections в паметта, затова
// insert-ите на ЕДИН процес не стигат автоматично до сокетите на другите.
// Стратегия: (1) веднага след локален insert/delete — синхронен local
// broadcast към собствените абонати (нулева латентност); (2) лек периодичен
// poll (LOBBY_CHAT_POLL_INTERVAL_MS) на споделената SQLite таблица по
// монотонен `seq`/`event_seq` cursor — announce-ва само редове, които тази
// инстанция все още не е обявила локално (собствените insert-и вече са
// напреднали cursor-а синхронно, така че poll-ът естествено announce-ва само
// съобщения/изтривания от ДРУГИ инстанции — виж runLobbyChatCrossInstancePoll).
const lobbyChatSubscriberConnectionIds = new Set<ConnectionId>()

const LOBBY_CHAT_HISTORY_LIMIT = 50
// "Публикации от Pika.bg" cutover marker — прочетен ЕДНАГА при startup от
// admin_settings (seed-нат ЕДИН ПЪТ от migration 20260817_001, никога не се
// преизчислява при restart). Съобщения от преди cutover-а (стария общ Live
// Chat, включително от admin/pika_team податели) остават в базата, но не се
// изпращат като история — виж lobbyChatStore.listRecentMessages извикването
// по-долу. НЕ ползвай lobbyChatLastAnnouncedSeq (getMaxSeq() при startup) за
// това — той е cross-instance broadcast dedup baseline, различна семантика.
const lobbyChatPikaAnnouncementCutoffSeq = adminSettingsStore.getLobbyChatPikaAnnouncementCutoffSeq()
const LOBBY_CHAT_POLL_INTERVAL_MS = 700
const LOBBY_CHAT_POLL_BATCH_SIZE = 200
const LOBBY_CHAT_RETENTION_DAYS = 30
const LOBBY_CHAT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000
const LOBBY_CHAT_RETENTION_STARTUP_DELAY_MS = 45 * 1000
const LOBBY_CHAT_RETENTION_BATCH_SIZE = 500
const LOBBY_CHAT_RATE_LIMIT_WINDOW_MS = 10_000
const LOBBY_CHAT_RATE_LIMIT_MAX_PER_WINDOW = 5
const LOBBY_CHAT_RATE_LIMIT_CLEANUP_INTERVAL_MS = 30_000
const LOBBY_CHAT_DUPLICATE_GUARD_MS = 8_000

type LobbyChatRateLimitEntry = { count: number; windowStartedAt: number }
const lobbyChatRateLimitByProfileId = new Map<string, LobbyChatRateLimitEntry>()
let lobbyChatRateLimitLastCleanupAt = 0

type LobbyChatLastMessageEntry = { normalizedBody: string; sentAt: number }
const lobbyChatLastMessageByProfileId = new Map<string, LobbyChatLastMessageEntry>()

// Cache: viewerProfileId -> Set(blockedProfileId) — избягва
// blockStore.getBlockedProfileIds() при ВСЕКИ recipient на ВСЯКО broadcast-нато
// съобщение. Инвалидира се изрично при (un)block действие (виж handleProfileBlockRequest).
// Ограничена по размер (LOBBY_CHAT_BLOCK_CACHE_MAX_ENTRIES) с изтриване на
// least-recently-used записите — без това, при дълго работещ процес кешът би
// растял неограничено с всеки различен профил, отворил лайв чата някога.
const LOBBY_CHAT_BLOCK_CACHE_MAX_ENTRIES = 5000
const LOBBY_CHAT_BLOCK_CACHE_CLEANUP_INTERVAL_MS = 60_000
let lobbyChatBlockCacheLastCleanupAt = 0

type LobbyChatBlockCacheEntry = { blockedProfileIds: Set<string>; lastAccessedAt: number }
const lobbyChatBlockCache = new Map<string, LobbyChatBlockCacheEntry>()

function cleanupLobbyChatBlockCacheIfNeeded(now: number): void {
  if (
    now - lobbyChatBlockCacheLastCleanupAt < LOBBY_CHAT_BLOCK_CACHE_CLEANUP_INTERVAL_MS ||
    lobbyChatBlockCache.size <= LOBBY_CHAT_BLOCK_CACHE_MAX_ENTRIES
  ) {
    return
  }
  lobbyChatBlockCacheLastCleanupAt = now

  const sortedByOldest = [...lobbyChatBlockCache.entries()]
    .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)
  const deleteCount = lobbyChatBlockCache.size - LOBBY_CHAT_BLOCK_CACHE_MAX_ENTRIES
  for (let i = 0; i < deleteCount; i++) {
    lobbyChatBlockCache.delete(sortedByOldest[i]![0])
  }
}

function getLobbyChatBlockedSet(viewerProfileId: string): Set<string> {
  const now = Date.now()
  const cached = lobbyChatBlockCache.get(viewerProfileId)
  if (cached !== undefined) {
    cached.lastAccessedAt = now
    return cached.blockedProfileIds
  }
  const fresh = new Set(blockStore.getBlockedProfileIds(viewerProfileId))
  lobbyChatBlockCache.set(viewerProfileId, { blockedProfileIds: fresh, lastAccessedAt: now })
  cleanupLobbyChatBlockCacheIfNeeded(now)
  return fresh
}

function invalidateLobbyChatBlockCache(profileId: string): void {
  lobbyChatBlockCache.delete(profileId)
}

let lobbyChatLastAnnouncedSeq = lobbyChatStore.getMaxSeq()
let lobbyChatLastAnnouncedDeletionEventSeq = lobbyChatStore.getMaxDeletionEventSeq()

function checkLobbyChatRateLimit(profileId: string, now: number = Date.now()): boolean {
  const existing = lobbyChatRateLimitByProfileId.get(profileId)

  if (!existing || now - existing.windowStartedAt >= LOBBY_CHAT_RATE_LIMIT_WINDOW_MS) {
    lobbyChatRateLimitByProfileId.set(profileId, { count: 1, windowStartedAt: now })
    return true
  }

  if (existing.count >= LOBBY_CHAT_RATE_LIMIT_MAX_PER_WINDOW) {
    return false
  }

  existing.count += 1
  return true
}

function isDuplicateLobbyChatMessage(profileId: string, normalizedBody: string, now: number = Date.now()): boolean {
  const last = lobbyChatLastMessageByProfileId.get(profileId)
  return last !== undefined
    && last.normalizedBody === normalizedBody
    && now - last.sentAt < LOBBY_CHAT_DUPLICATE_GUARD_MS
}

function recordLobbyChatSentMessage(profileId: string, normalizedBody: string, now: number = Date.now()): void {
  lobbyChatLastMessageByProfileId.set(profileId, { normalizedBody, sentAt: now })
}

function cleanupLobbyChatRateLimitState(now: number): void {
  if (now - lobbyChatRateLimitLastCleanupAt < LOBBY_CHAT_RATE_LIMIT_CLEANUP_INTERVAL_MS) {
    return
  }
  lobbyChatRateLimitLastCleanupAt = now

  for (const [profileId, entry] of lobbyChatRateLimitByProfileId.entries()) {
    if (now - entry.windowStartedAt >= LOBBY_CHAT_RATE_LIMIT_WINDOW_MS) {
      lobbyChatRateLimitByProfileId.delete(profileId)
    }
  }

  for (const [profileId, entry] of lobbyChatLastMessageByProfileId.entries()) {
    if (now - entry.sentAt >= LOBBY_CHAT_DUPLICATE_GUARD_MS) {
      lobbyChatLastMessageByProfileId.delete(profileId)
    }
  }
}

type LobbyChatBroadcastSnapshot = {
  seq: number
  messageId: string
  senderProfileId: string
  senderDisplayName: string
  senderIsChatAdmin: boolean
  senderRole: 'player' | 'chat_admin' | 'pika_team' | 'top_chat_admin' | 'subadmin' | 'admin'
  body: string
  createdAt: string
}

function broadcastLobbyChatMessageToLocalSubscribers(
  snapshot: LobbyChatBroadcastSnapshot,
  opts?: { originatingConnectionId?: ConnectionId; requestId?: string },
): void {
  for (const subscriberConnectionId of [...lobbyChatSubscriberConnectionIds]) {
    const subscriberConnection = getConnectionById(serverState, subscriberConnectionId)
    const socket = socketRegistry.get(subscriberConnectionId)

    if (subscriberConnection === null || !socket || socket.readyState !== WebSocket.OPEN) {
      lobbyChatSubscriberConnectionIds.delete(subscriberConnectionId)
      continue
    }

    if (
      subscriberConnection.profileId !== null &&
      getLobbyChatBlockedSet(subscriberConnection.profileId).has(snapshot.senderProfileId)
    ) {
      continue
    }

    const isOriginator = opts?.originatingConnectionId === subscriberConnectionId

    safeSendToConnection(subscriberConnectionId, {
      type: 'lobby_chat_message',
      seq: snapshot.seq,
      messageId: snapshot.messageId,
      senderProfileId: snapshot.senderProfileId,
      senderDisplayName: snapshot.senderDisplayName,
      senderIsChatAdmin: snapshot.senderIsChatAdmin,
      senderRole: snapshot.senderRole,
      body: snapshot.body,
      createdAt: snapshot.createdAt,
      ...(isOriginator && opts?.requestId ? { requestId: opts.requestId } : {}),
    })
  }
}

function broadcastLobbyChatDeletionToLocalSubscribers(messageId: string): void {
  for (const subscriberConnectionId of [...lobbyChatSubscriberConnectionIds]) {
    const subscriberConnection = getConnectionById(serverState, subscriberConnectionId)
    const socket = socketRegistry.get(subscriberConnectionId)

    if (subscriberConnection === null || !socket || socket.readyState !== WebSocket.OPEN) {
      lobbyChatSubscriberConnectionIds.delete(subscriberConnectionId)
      continue
    }

    safeSendToConnection(subscriberConnectionId, {
      type: 'lobby_chat_message_deleted',
      messageId,
    })
  }
}

function runLobbyChatCrossInstancePoll(): void {
  if (isServerShuttingDown) {
    return
  }

  const tickStartedAtMs = performance.now()
  try {
    runLobbyChatCrossInstancePollUnsafe()
  } finally {
    backgroundJobMetrics.record('lobbyChatPoll', performance.now() - tickStartedAtMs)
  }
}

function runLobbyChatCrossInstancePollUnsafe(): void {
  const now = Date.now()
  cleanupLobbyChatRateLimitState(now)

  try {
    const newMessages = lobbyChatStore.pollNewMessages(lobbyChatLastAnnouncedSeq, LOBBY_CHAT_POLL_BATCH_SIZE)
    for (const message of newMessages) {
      lobbyChatLastAnnouncedSeq = Math.max(lobbyChatLastAnnouncedSeq, message.seq)

      if (message.deletedAt !== null) {
        // Вмъкнато И изтрито (от друга инстанция) между два тика на тази
        // инстанция — deletion poll-ът по-долу announce-ва изтриването;
        // тук не показваме съобщение, което вече не съществува.
        continue
      }

      broadcastLobbyChatMessageToLocalSubscribers(message)
    }
  } catch (error) {
    console.error('[lobby-chat] cross-instance message poll failed:', error)
  }

  try {
    const deletionEvents = lobbyChatStore.pollDeletionEvents(
      lobbyChatLastAnnouncedDeletionEventSeq,
      LOBBY_CHAT_POLL_BATCH_SIZE,
    )
    for (const event of deletionEvents) {
      lobbyChatLastAnnouncedDeletionEventSeq = Math.max(lobbyChatLastAnnouncedDeletionEventSeq, event.eventSeq)
      broadcastLobbyChatDeletionToLocalSubscribers(event.messageId)
    }
  } catch (error) {
    console.error('[lobby-chat] cross-instance deletion poll failed:', error)
  }
}

let lobbyChatPollInterval: ReturnType<typeof setInterval> | null = setInterval(
  runLobbyChatCrossInstancePoll,
  LOBBY_CHAT_POLL_INTERVAL_MS,
)

function runLobbyChatRetentionCleanup(): void {
  if (isServerShuttingDown) {
    return
  }

  try {
    const result = lobbyChatStore.purgeOlderThanDays(LOBBY_CHAT_RETENTION_DAYS, LOBBY_CHAT_RETENTION_BATCH_SIZE)
    if (result.deletedMessages > 0 || result.deletedDeletionEvents > 0) {
      console.log(
        `[lobby-chat] Retention cleanup: deleted messages=${result.deletedMessages} deletionEvents=${result.deletedDeletionEvents}`,
      )
    }
  } catch (error) {
    console.error('[lobby-chat] Retention cleanup failed:', error)
  }
}

let lobbyChatRetentionStartupTimeout: ReturnType<typeof setTimeout> | null = setTimeout(
  runLobbyChatRetentionCleanup,
  LOBBY_CHAT_RETENTION_STARTUP_DELAY_MS,
)
let lobbyChatRetentionInterval: ReturnType<typeof setInterval> | null = setInterval(
  runLobbyChatRetentionCleanup,
  LOBBY_CHAT_RETENTION_INTERVAL_MS,
)

// ─── "Теми" (Topics) realtime — root съобщения, Етап 2 ─────────────────────
//
// Същия instant-local-broadcast + cross-instance-poll модел като lobby chat
// по-горе, НО с коригиран poll cursor invariant:
//
//   topicMessagePollCursor се движи ИЗКЛЮЧИТЕЛНО вътре в
//   runTopicMessagesCrossInstancePoll, и то само на seq-а на реда, който
//   poll-ът току-що е прочел от DB — НИКОГА от local send пътя.
//
// Причина: ако local send напредваше cursor-а директно на своя seq (какъвто
// е моделът на lobbyChatLastAnnouncedSeq по-горе), следният race е възможен —
// instance A cursor=100; instance B insert-ва seq=101 (A не знае още);
// instance A insert-ва локално seq=102 и би преместил cursor-а на 102 директно
// → seq=101 е изгубен завинаги за A-related subscribers, защото следващият
// poll на A би прочел "seq > 102", прескачайки 101. Затова local send тук
// САМО маркира своя seq в topicMessageLocallyAnnouncedSeqs (bounded set) —
// за да не бъде broadcast-нат ВТОРИ път, когато по-късно poll-ът стигне до
// същия ред — но никога не пипа cursor-а. Виж
// server/scripts/checkTopicMessagesRealtime.ts за regression test на точно
// този сценарий.
//
// Subscription модел: за разлика от lobby chat (единствен глобален канал),
// Topics UX показва точно ЕДНА активна тема наведнъж (хоризонтална
// навигация) — затова connection→topicId е скалар (не Set), което прави
// cleanup при disconnect/switch O(1) вместо обхождане на всички теми.

const topicMessageSubscriberTopicIdByConnectionId = new Map<ConnectionId, string>()
const topicMessageSubscribersByTopicId = new Map<string, Set<ConnectionId>>()

// Directory-wide "гледам списъка с теми" interest (Custom Topic Creation) —
// mirror на lobbyChatSubscriberConnectionIds (единствен глобален канал, не
// per-topic Map), защото "нова тема се появи" е relevant за ВСЕКИ клиент в
// Topics директорията, независимо коя конкретна тема гледа в момента.
const topicsDirectorySubscriberConnectionIds = new Set<ConnectionId>()

const TOPIC_MESSAGES_REALTIME_CATCHUP_LIMIT = 50
// "Лафче" system topic — fixed id, seed-нат от migration 20260817_002 (mirror
// на topic-general seed-a). Reuse-ва изцяло topics/topic_messages
// инфраструктурата (Вариант A от inspection брифа), НЕ нова таблица.
const LAFCHE_TOPIC_ID = 'topic-lafche'
// "Последните 200 root posts" (canonical retention limit, синхронизиран с
// client LAFCHE_MESSAGE_HISTORY_LIMIT — renderTopicsScreen.ts) — покрива
// TOPIC_MESSAGES_REALTIME_CATCHUP_LIMIT-а по-горе (50) само за първоначален
// catch-up; getRecentMessages с explicit по-висок limit се ползва за HTTP
// initial-load handler-а (виж handleTopicMessagesRequest). Server-side hard
// retention (enforceLafcheRetention по-долу) поддържа DB-то самото <=200
// steady-state след explicit backlog normalization (виж
// scripts/lafcheRetentionCleanup.ts) — преди тази нормализация DB може
// временно да съдържа legacy backlog >200, четим, но НЕ mass-delete-ван от
// нормалния request path (виж enforceLafcheRetention guard-а).
const LAFCHE_MESSAGE_HISTORY_LIMIT = 200
const TOPIC_MESSAGE_POLL_BATCH_SIZE = 200
const TOPIC_MESSAGE_RATE_LIMIT_WINDOW_MS = 10_000
const TOPIC_MESSAGE_RATE_LIMIT_MAX_PER_WINDOW = 5
const TOPIC_MESSAGE_RATE_LIMIT_CLEANUP_INTERVAL_MS = 30_000
const TOPIC_MESSAGE_DUPLICATE_GUARD_MS = 8_000
const TOPIC_MESSAGE_LOCALLY_ANNOUNCED_TTL_MS = 30_000

type TopicMessageRateLimitEntry = { count: number; windowStartedAt: number }
// Отделен bucket от lobbyChatRateLimitByProfileId — писане в Теми не трябва
// да consume-ва/бъде consume-нато от квотата на общия лайв чат.
const topicMessageRateLimitByProfileId = new Map<string, TopicMessageRateLimitEntry>()
let topicMessageRateLimitLastCleanupAt = 0

type TopicMessageLastSentEntry = { normalizedBody: string; sentAt: number }
// Ключ: `${profileId}:${topicId}:${parentMessageId ?? 'root'}` (Етап 3
// разширение — виж duplicateTopicMessageKey) — duplicate guard-ът е scoped
// ПО ТЕМА+ROOT (Етап 2 брифа т.7), НЕ глобално per profile, за да не блокира
// легитимно еднакъв кратък текст в различни теми/root threads.
const topicMessageLastSentByProfileAndTopic = new Map<string, TopicMessageLastSentEntry>()

// ─── Likes (Етап 3) — rate limit + cross-instance drift-detection polling ──
//
// Likes НЯМАТ собствен seq в topic_messages (toggle е DELETE-or-INSERT в
// topic_message_likes, не append-only log) — затова cross-instance
// realtime за likes НЕ може да reuse-не directly poll-cursor invariant-а на
// root/reply. Вместо event-replay модел, ползваме lightweight AGGREGATE
// drift-detection polling: на всеки tick, за message-ите с локални
// subscribers в момента, сравняваме текущия DB likeCount с последно
// известния и broadcast-ваме САМО делтата. Latency е ограничен от
// TOPIC_MESSAGE_LIKE_POLL_INTERVAL_MS (секунди), не instant — приет trade-off
// (виж Етап 3 плана, "Cross-instance strategy — Likes": read-mostly
// aggregate числа не оправдават нов seq-log за instant sync).
const TOPIC_MESSAGE_LIKE_RATE_LIMIT_WINDOW_MS = 10_000
const TOPIC_MESSAGE_LIKE_RATE_LIMIT_MAX_PER_WINDOW = 20
const TOPIC_MESSAGE_LIKE_LOCALLY_ANNOUNCED_TTL_MS = 15_000
const TOPIC_MESSAGE_LIKE_POLL_INTERVAL_MS = 4_000

type TopicMessageRateLimitEntry2 = { count: number; windowStartedAt: number }
const topicMessageLikeRateLimitByProfileId = new Map<string, TopicMessageRateLimitEntry2>()
let topicMessageLikeRateLimitLastCleanupAt = 0

function checkTopicMessageLikeRateLimit(profileId: string, now: number = Date.now()): boolean {
  const existing = topicMessageLikeRateLimitByProfileId.get(profileId)

  if (!existing || now - existing.windowStartedAt >= TOPIC_MESSAGE_LIKE_RATE_LIMIT_WINDOW_MS) {
    topicMessageLikeRateLimitByProfileId.set(profileId, { count: 1, windowStartedAt: now })
    return true
  }

  if (existing.count >= TOPIC_MESSAGE_LIKE_RATE_LIMIT_MAX_PER_WINDOW) {
    return false
  }

  existing.count += 1
  return true
}

function cleanupTopicMessageLikeRateLimitState(now: number): void {
  if (now - topicMessageLikeRateLimitLastCleanupAt < TOPIC_MESSAGE_RATE_LIMIT_CLEANUP_INTERVAL_MS) {
    return
  }
  topicMessageLikeRateLimitLastCleanupAt = now
  for (const [profileId, entry] of topicMessageLikeRateLimitByProfileId.entries()) {
    if (now - entry.windowStartedAt >= TOPIC_MESSAGE_LIKE_RATE_LIMIT_WINDOW_MS) {
      topicMessageLikeRateLimitByProfileId.delete(profileId)
    }
  }
}

// messageId -> кога е бил toggle-нат локално от ТОЗИ instance. Poll tick-ът
// прескача broadcast на count, който вече е бил local-instant-broadcast-нат
// за same messageId в последните TTL мс (same-instance echo suppression,
// аналогично на topicMessageLocallyAnnouncedSeqs, но keyed по messageId, не
// seq — likes нямат ordered seq).
const topicMessageLikeLocallyAnnouncedAt = new Map<string, number>()
// Последно излъчения (или локално известен) likeCount per messageId — за
// drift detection: poll-ът broadcast-ва САМО ако текущия DB count се различава.
const topicMessageLikeLastKnownCountByMessageId = new Map<string, number>()

function checkTopicMessageRateLimit(profileId: string, now: number = Date.now()): boolean {
  const existing = topicMessageRateLimitByProfileId.get(profileId)

  if (!existing || now - existing.windowStartedAt >= TOPIC_MESSAGE_RATE_LIMIT_WINDOW_MS) {
    topicMessageRateLimitByProfileId.set(profileId, { count: 1, windowStartedAt: now })
    return true
  }

  if (existing.count >= TOPIC_MESSAGE_RATE_LIMIT_MAX_PER_WINDOW) {
    return false
  }

  existing.count += 1
  return true
}

// parentMessageId=null → root sentinel ('root') — пази точно предишния key
// space непроменен за root съобщения. Не-null → reply, keyed отделно по
// parentMessageId, за да не третира reply към root-A като duplicate на reply
// със същия текст към root-B (Етап 3 брифа: "еднакъв текст в две различни
// теми е допустим" — същия принцип, разширен и за различни root parent-и).
function duplicateTopicMessageKey(profileId: string, topicId: string, parentMessageId: string | null): string {
  return `${profileId}:${topicId}:${parentMessageId ?? 'root'}`
}

function isDuplicateTopicMessage(
  profileId: string,
  topicId: string,
  parentMessageId: string | null,
  normalizedBody: string,
  now: number = Date.now(),
): boolean {
  const last = topicMessageLastSentByProfileAndTopic.get(duplicateTopicMessageKey(profileId, topicId, parentMessageId))
  return last !== undefined
    && last.normalizedBody === normalizedBody
    && now - last.sentAt < TOPIC_MESSAGE_DUPLICATE_GUARD_MS
}

function recordTopicMessageSent(
  profileId: string,
  topicId: string,
  parentMessageId: string | null,
  normalizedBody: string,
  now: number = Date.now(),
): void {
  topicMessageLastSentByProfileAndTopic.set(duplicateTopicMessageKey(profileId, topicId, parentMessageId), { normalizedBody, sentAt: now })
}

function cleanupTopicMessageRateLimitState(now: number): void {
  if (now - topicMessageRateLimitLastCleanupAt < TOPIC_MESSAGE_RATE_LIMIT_CLEANUP_INTERVAL_MS) {
    return
  }
  topicMessageRateLimitLastCleanupAt = now

  for (const [profileId, entry] of topicMessageRateLimitByProfileId.entries()) {
    if (now - entry.windowStartedAt >= TOPIC_MESSAGE_RATE_LIMIT_WINDOW_MS) {
      topicMessageRateLimitByProfileId.delete(profileId)
    }
  }

  for (const [key, entry] of topicMessageLastSentByProfileAndTopic.entries()) {
    if (now - entry.sentAt >= TOPIC_MESSAGE_DUPLICATE_GUARD_MS) {
      topicMessageLastSentByProfileAndTopic.delete(key)
    }
  }
}

// viewer-agnostic частта на broadcast snapshot-а — likeCount/replyCount/
// avatar са едни и същи за всички subscribers, но viewerHasLiked е
// per-subscriber (виж appendViewerHasLiked по-долу) и НЕ може да е тук.
type TopicMessageBroadcastBase = Omit<TopicMessageBroadcastSnapshot, 'viewerHasLiked'>
type TopicReplyBroadcastBase = Omit<TopicReplyBroadcastSnapshot, 'viewerHasLiked'>

// Batch avatar+aggregate hydration — reuse-ва playerProgressStore.getProfileSnapshotsByIds,
// СЪЩИЯТ batch helper, ползван от REST enrichment-а в handleTopicMessagesRequest
// (Етап 1), плюс topicMessageStore.getMessageAggregatesByIds (Етап 3) за
// likeCount/replyCount — за да не се получи N+1 profile/aggregate lookup нито
// при catch-up batch, нито при cross-instance poll batch (Етап 2 брифа т.3:
// "НЕ прави profile/avatar lookup по един sender на message", Етап 3 брифа
// т.9: "не N+1 COUNT(*) на всяко message"). Извиква се ВИНАГИ с целия batch
// накуп, никога в цикъл по едно съобщение. viewerProfileId=null тук нарочно —
// aggregates-ите, върнати оттук, са viewer-AGNOSTIC (likeCount/replyCount),
// viewerHasLiked се добавя отделно per-subscriber (appendViewerHasLiked).
// Reuse на СЪЩИЯ URL shape като chatStore.ts buildAttachmentUrls — viewUrl/
// downloadUrl построени тук (не в store слоя, който не знае нищо за HTTP
// routing), топлика с protected download endpoint-а по-долу
// (handleTopicAttachmentDownloadRequest).
function buildTopicAttachmentUrls(topicId: string, storageFilename: string): { viewUrl: string; downloadUrl: string } {
  const base = `/api/topics/${encodeURIComponent(topicId)}/attachments/${encodeURIComponent(storageFilename)}`
  return { viewUrl: base, downloadUrl: `${base}?download=1` }
}

// Lafche retention hotfix — mute evidence attachment URL, разклонено по
// isEvidenceCopy: false (default/legacy) → нормалният topic-attachment route
// (source постът все още е жив, в рамките на newest-N, N=LAFCHE_MESSAGE_HISTORY_LIMIT); true → protected
// moderation-only evidence endpoint (source вече hard-deleted от retention,
// файлът живее в отделен protected storage, виж
// handleTopicMuteEvidenceAttachmentDownloadRequest).
function buildTopicMuteEvidenceAttachmentUrls(
  topicId: string,
  storageFilename: string,
  isEvidenceCopy: boolean,
): { viewUrl: string; downloadUrl: string } {
  if (isEvidenceCopy) {
    const base = `/api/topics/mute-evidence/attachments/${encodeURIComponent(storageFilename)}`
    return { viewUrl: base, downloadUrl: base }
  }
  return buildTopicAttachmentUrls(topicId, storageFilename)
}

function hydrateTopicMessagesWithCurrentAvatars(
  messages: readonly TopicMessageSnapshot[],
): TopicMessageBroadcastBase[] {
  const uniqueSenderProfileIds = [...new Set(messages.map((m) => m.senderProfileId))]
  const senderProfiles = playerProgressStore.getProfileSnapshotsByIds(uniqueSenderProfileIds)
  const avatarUrlByProfileId = new Map(senderProfiles.map((p) => [p.profileId, p.avatarUrl]))
  // Batch lookup — ЕДНА заявка за целия batch sender profile IDs (mute
  // indicator icon брифа §8), не N+1 lookup по съобщение.
  const activeSectionMutedProfileIds = topicModerationStore.getActiveSectionMutedProfileIds(uniqueSenderProfileIds)

  const messageIds = messages.map((m) => m.messageId)
  const aggregatesByMessageId = topicMessageStore.getMessageAggregatesByIds(messageIds, null)
  // Batch attachment lookup — ЕДНА заявка за целия batch, не N+1 (виж
  // getAttachmentsByMessageIds коментара в topicMessageStore.ts).
  const attachmentsByMessageId = topicMessageStore.getAttachmentsByMessageIds(messageIds)

  return messages.map((message) => {
    const attachmentRecord = attachmentsByMessageId.get(message.messageId)
    const attachment = attachmentRecord
      ? {
          attachmentId: attachmentRecord.storageFilename,
          width: attachmentRecord.width,
          height: attachmentRecord.height,
          byteSize: attachmentRecord.byteSize,
          ...buildTopicAttachmentUrls(message.topicId, attachmentRecord.storageFilename),
        }
      : null

    return {
      seq: message.seq,
      messageId: message.messageId,
      topicId: message.topicId,
      parentMessageId: message.parentMessageId,
      senderProfileId: message.senderProfileId,
      senderDisplayName: message.senderDisplayName,
      senderAvatarUrl: avatarUrlByProfileId.get(message.senderProfileId) ?? null,
      senderRole: message.senderRole,
      body: message.body,
      createdAt: message.createdAt,
      lastActivityAt: message.lastActivityAt,
      unreadCount: 0,
      editedAt: message.editedAt,
      attachment,
      likeCount: aggregatesByMessageId.get(message.messageId)?.likeCount ?? 0,
      replyCount: aggregatesByMessageId.get(message.messageId)?.replyCount ?? 0,
      isTopicsSectionMuted: activeSectionMutedProfileIds.has(message.senderProfileId),
    }
  })
}

// viewerHasLiked е per-subscriber private state — не може да е част от
// общия (viewer-agnostic) snapshot, изчислен веднъж за целия broadcast batch.
// Единичен lookup тук е евтин (message_id+profile_id PK lookup), извикан по
// веднъж на subscriber на broadcast (не N+1 върху batch-а от съобщения —
// самият snapshot batch си остава single query, виж hydrateTopicMessagesWithCurrentAvatars).
function viewerHasLikedMessage(messageId: string, viewerProfileId: string | null): boolean {
  if (viewerProfileId === null) return false
  const aggregates = topicMessageStore.getMessageAggregatesByIds([messageId], viewerProfileId)
  return aggregates.get(messageId)?.viewerHasLiked ?? false
}

// Perf audit fix (N+1 fan-out): по-рано тук викахме viewerAwareReplyCount/
// getTopicThreadUnreadCountForProfile/viewerHasLikedMessage ВЪТРЕ в for
// цикъла — по 2-3 sync SQLite заявки НА ВСЕКИ subscriber connection. При 62
// online users с ~35 topic subscribers, това бяха ~100+ последователни
// заявки на event loop-а за един-единствен пост.
//
// Двупроходен подход вместо това: (1) събираме живите connections + set от
// УНИКАЛНИ viewer profileId-та (dedupe — 2+ connections на един профил, напр.
// desktop+mobile таб, вече не тригват повторна DB работа); (2) правим batch
// fetch ЕДИН път на уникален профил (не на connection) за replyCount+
// viewerHasLiked (topicMessageStore.getBroadcastViewerDataForProfiles — 2
// заявки ОБЩО, не 2×N) и unreadCount (getTopicThreadUnreadCountForProfile,
// извикан веднъж на уникален profileId чрез dedupe cache, не premahната
// заявка сама по себе си — виж коментара долу защо тя остава per-profile);
// (3) вторият loop прави само map lookup + socket send, БЕЗ SQL заявки.
// Точната семантика (block-aware replyCount, per-viewer unreadCount/like
// state, anonymous/guest 0-defaults) остава непроменена — виж performance
// audit-а и getBroadcastViewerDataForProfiles коментара в topicMessageStore.ts.
function broadcastTopicMessageToLocalSubscribers(
  topicId: string,
  snapshot: TopicMessageBroadcastBase,
  opts?: { originatingConnectionId?: ConnectionId; requestId?: string },
): void {
  const subscribers = topicMessageSubscribersByTopicId.get(topicId)

  // ВАЖНО: по-рано тук имаше early-return, ако НИКОЙ не гледа точно тази
  // тема в момента (subscribers.size === 0) — това пропускаше и
  // reconcileTopicUnreadForDirectorySubscribers по-долу, значи badge-ът за
  // directory subscribers (напр. "Лафче" червената точка / ТЕМИ / Меню
  // агрегатите) никога не се обновяваше realtime, ако никой активно не
  // гледаше темата в момента на новия пост (production bug). Per-viewer
  // push цикълът остава условен на реални subscribers, но directory
  // reconciliation-ът ТРЯБВА да се извиква безусловно.
  if (subscribers !== undefined && subscribers.size > 0) {
    const liveRecipients: Array<{ connectionId: ConnectionId; profileId: string | null }> = []

    for (const subscriberConnectionId of [...subscribers]) {
      const subscriberConnection = getConnectionById(serverState, subscriberConnectionId)
      const socket = socketRegistry.get(subscriberConnectionId)

      if (subscriberConnection === null || !socket || socket.readyState !== WebSocket.OPEN) {
        subscribers.delete(subscriberConnectionId)
        topicMessageSubscriberTopicIdByConnectionId.delete(subscriberConnectionId)
        continue
      }

      // Viewer-side hard-exclude — СЪЩИЯТ getLobbyChatBlockedSet helper, ползван
      // от Topics REST history (Етап 1) — realtime push НЕ трябва да заобикаля
      // block semantics-а, който REST-ът вече налага (Етап 2 брифа т.9).
      if (
        subscriberConnection.profileId !== null &&
        getLobbyChatBlockedSet(subscriberConnection.profileId).has(snapshot.senderProfileId)
      ) {
        continue
      }

      liveRecipients.push({ connectionId: subscriberConnectionId, profileId: subscriberConnection.profileId })
    }

    const uniqueViewerProfileIds = [...new Set(
      liveRecipients.map((r) => r.profileId).filter((id): id is string => id !== null),
    )]

    const excludedSendersByViewer = new Map<string, ReadonlySet<string>>(
      uniqueViewerProfileIds.map((id) => [id, getLobbyChatBlockedSet(id)]),
    )
    const viewerDataByProfileId = topicMessageStore.getBroadcastViewerDataForProfiles(
      snapshot.messageId,
      uniqueViewerProfileIds,
      excludedSendersByViewer,
    )
    // Perf audit follow-up: по-рано тук имаше loop, викащ
    // getTopicThreadUnreadCountForProfile (единичен SQL statement) ВЕДНЪЖ на
    // уникален profileId — O(uniqueProfiles) statements per broadcast.
    // getTopicThreadUnreadCountsForProfiles прави фиксиран малък брой SQL
    // statements (независим от profile count) за целия batch наведнъж.
    const unreadCountByProfileId = getTopicThreadUnreadCountsForProfiles(
      snapshot.messageId,
      uniqueViewerProfileIds,
      excludedSendersByViewer,
    )

    for (const recipient of liveRecipients) {
      const isOriginator = opts?.originatingConnectionId === recipient.connectionId
      const viewerData = recipient.profileId !== null ? viewerDataByProfileId.get(recipient.profileId) : undefined

      safeSendToConnection(recipient.connectionId, {
        type: 'topic_message',
        ...snapshot,
        // replyCount override-ва shared base стойността (viewer-agnostic global
        // count от hydrateTopicMessagesWithCurrentAvatars) с viewer-aware брой —
        // blocked sender-и на ТОЗИ subscriber не се броят.
        replyCount: viewerData?.replyCount ?? 0,
        unreadCount: recipient.profileId === null ? 0 : (unreadCountByProfileId.get(recipient.profileId) ?? 0),
        viewerHasLiked: viewerData?.viewerHasLiked ?? false,
        ...(isOriginator && opts?.requestId ? { requestId: opts.requestId } : {}),
      })
    }
  }

  reconcileTopicUnreadForDirectorySubscribers(topicId, snapshot.senderProfileId, snapshot.messageId)
}

// Огледално на broadcastTopicMessageToLocalSubscribers, за reply push (Етап
// 3). Reply-и се показват САМО когато viewer-ът има expanded-нат съответния
// root thread — но сървърът не следи expanded state client-side, затова
// broadcast-ва към ВСИЧКИ topic subscribers (клиентът решава дали да
// append-не в DOM-а или само да инкрементира replyCount локално, виж Етап 3
// брифа: "ако collapsed → само counter се обновява"). Blocking filter е
// идентичен на root.
// Perf audit fix — mirror на broadcastTopicMessageToLocalSubscribers по-горе:
// batch-нат viewerHasLiked lookup веднъж на уникален profileId (dedupe по
// connection), не отделна SQL заявка на всеки subscriber connection.
function broadcastTopicReplyToLocalSubscribers(
  topicId: string,
  snapshot: TopicReplyBroadcastBase,
  opts?: { originatingConnectionId?: ConnectionId; requestId?: string },
): void {
  const subscribers = topicMessageSubscribersByTopicId.get(topicId)
  if (subscribers === undefined || subscribers.size === 0) {
    return
  }

  const liveRecipients: Array<{ connectionId: ConnectionId; profileId: string | null }> = []

  for (const subscriberConnectionId of [...subscribers]) {
    const subscriberConnection = getConnectionById(serverState, subscriberConnectionId)
    const socket = socketRegistry.get(subscriberConnectionId)

    if (subscriberConnection === null || !socket || socket.readyState !== WebSocket.OPEN) {
      subscribers.delete(subscriberConnectionId)
      topicMessageSubscriberTopicIdByConnectionId.delete(subscriberConnectionId)
      continue
    }

    if (
      subscriberConnection.profileId !== null &&
      getLobbyChatBlockedSet(subscriberConnection.profileId).has(snapshot.senderProfileId)
    ) {
      continue
    }

    liveRecipients.push({ connectionId: subscriberConnectionId, profileId: subscriberConnection.profileId })
  }

  const uniqueViewerProfileIds = [...new Set(
    liveRecipients.map((r) => r.profileId).filter((id): id is string => id !== null),
  )]
  // excludedSenderProfileIdsByViewer не влияе на viewerHasLiked (единственото
  // поле, което ползваме тук) — подаваме празни sets, replyCount резултатното
  // поле остава неизползвано за reply broadcast-и (replies нямат собствен
  // replyCount override).
  const emptyExclusions = new Map<string, ReadonlySet<string>>()
  const viewerDataByProfileId = topicMessageStore.getBroadcastViewerDataForProfiles(
    snapshot.messageId,
    uniqueViewerProfileIds,
    emptyExclusions,
  )

  for (const recipient of liveRecipients) {
    const isOriginator = opts?.originatingConnectionId === recipient.connectionId
    const viewerHasLiked = recipient.profileId !== null
      ? (viewerDataByProfileId.get(recipient.profileId)?.viewerHasLiked ?? false)
      : false

    safeSendToConnection(recipient.connectionId, {
      type: 'topic_reply',
      ...snapshot,
      viewerHasLiked,
      ...(isOriginator && opts?.requestId ? { requestId: opts.requestId } : {}),
    })
  }

  reconcileTopicUnreadForDirectorySubscribers(topicId, snapshot.senderProfileId, snapshot.parentMessageId)
}

// PUBLIC broadcast за like count промяна — само messageId+likeCount, БЕЗ
// liker identity и БЕЗ viewerHasLiked (private, виж topic_message_like_changed_self
// в самия toggle handler). Няма blocking filter тук нарочно — likeCount е
// aggregate/viewer-agnostic число (Етап 3 брифа: "block не променя aggregate
// count"), не разкрива нищо лично за подателя на самия like.
function broadcastTopicMessageLikeChangedToLocalSubscribers(topicId: string, messageId: string, likeCount: number): void {
  const subscribers = topicMessageSubscribersByTopicId.get(topicId)
  if (subscribers === undefined || subscribers.size === 0) {
    return
  }
  for (const subscriberConnectionId of [...subscribers]) {
    safeSendToConnection(subscriberConnectionId, {
      type: 'topic_message_like_changed',
      messageId,
      likeCount,
    })
  }
}

// ─── Moderation realtime (Етап 4) ────────────────────────────────────────

// Общ multi-connection push helper (потребител може да има desktop + mobile
// таб едновременно) — за target-only moderation notify (mute/unmute), за
// разлика от topic subscriber broadcast-ите по-горе. Не филтрира по
// currentRoomId (за разлика от gift notify pattern-а другаде в index.ts) —
// moderation state трябва да стигне до профила независимо дали в момента
// играе в стая.
function broadcastToProfileConnections(profileId: string, payload: unknown): void {
  for (const conn of Object.values(serverState.connections)) {
    if (conn.profileId === profileId) {
      safeSendToConnection(conn.id, payload)
    }
  }
}

function getTopicUnreadCountForProfile(profileId: string, topicId: string): number {
  const blocked = [...getLobbyChatBlockedSet(profileId)]
  const topic = topicStore.getTopicById(topicId)
  if (topic?.isGeneral) {
    return topicReadStateStore.getGeneralThreadUnreadTotal(profileId, topicId, blocked)
  }
  return topicReadStateStore.getUnreadCountsByTopicIds(profileId, [topicId], blocked).get(topicId) ?? 0
}

// Batch вариант — за N профила наведнъж, с фиксиран малък брой SQL
// statements (не loop, викащ getTopicUnreadCountForProfile N пъти). Reuse-ва
// batch store функциите (getGeneralThreadUnreadTotalsForProfiles /
// getUnreadCountForTopicForProfiles), branch-нато по isGeneral точно както
// единичната версия по-горе.
function getTopicUnreadCountsForProfiles(
  topicId: string,
  profileIds: readonly string[],
  excludedSenderProfileIdsByViewer: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, number> {
  const topic = topicStore.getTopicById(topicId)
  if (topic?.isGeneral) {
    return topicReadStateStore.getGeneralThreadUnreadTotalsForProfiles(topicId, profileIds, excludedSenderProfileIdsByViewer)
  }
  return topicReadStateStore.getUnreadCountForTopicForProfiles(topicId, profileIds, excludedSenderProfileIdsByViewer)
}

function topicsWithUnreadCountsForProfile(profileId: string, topics: TopicSnapshot[]): TopicSnapshot[] {
  const topicIds = topics.map((topic) => topic.topicId)
  topicReadStateStore.ensureReadStateForTopics(profileId, topicIds)
  const blocked = [...getLobbyChatBlockedSet(profileId)]
  const counts = topicReadStateStore.getUnreadCountsByTopicIds(profileId, topicIds, blocked)
  return topics.map((topic) => ({
    ...topic,
    unreadCount: topic.isGeneral
      ? topicReadStateStore.getGeneralThreadUnreadTotal(profileId, topic.topicId, blocked)
      : counts.get(topic.topicId) ?? 0,
  }))
}

function broadcastTopicSeenUpdatedToProfile(profileId: string, topicId: string, lastSeenSeq: number): void {
  broadcastToProfileConnections(profileId, {
    type: 'topic_seen_updated',
    topicId,
    lastSeenSeq,
    unreadCount: 0,
  })
}

function getTopicThreadUnreadCountForProfile(profileId: string, rootMessageId: string): number {
  const blocked = [...getLobbyChatBlockedSet(profileId)]
  return topicReadStateStore.getUnreadCountsByRootMessageIds(profileId, [rootMessageId], blocked).get(rootMessageId) ?? 0
}

// Batch вариант — за N профила наведнъж, ЕДИН thread (rootMessageId),
// фиксиран малък брой SQL statements (не loop по profileId).
function getTopicThreadUnreadCountsForProfiles(
  rootMessageId: string,
  profileIds: readonly string[],
  excludedSenderProfileIdsByViewer: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, number> {
  return topicReadStateStore.getThreadUnreadCountsForProfiles(rootMessageId, profileIds, excludedSenderProfileIdsByViewer)
}

function broadcastTopicThreadSeenUpdatedToProfile(profileId: string, topicId: string, rootMessageId: string, lastSeenSeq: number): void {
  broadcastToProfileConnections(profileId, {
    type: 'topic_thread_seen_updated',
    topicId,
    rootMessageId,
    lastSeenSeq,
    unreadCount: 0,
    topicUnreadCount: getTopicUnreadCountForProfile(profileId, topicId),
  })
}

function markTopicSeenForActiveProfile(profileId: string, topicId: string): void {
  const result = topicReadStateStore.markTopicSeenToLatestSeq(profileId, topicId)
  if (result.ok) {
    broadcastTopicSeenUpdatedToProfile(profileId, topicId, result.state.lastSeenSeq)
  }
}

function broadcastTopicUnreadCountsToProfile(profileId: string): void {
  const topics = topicStore.listActiveTopics()
  const enriched = topicsWithUnreadCountsForProfile(profileId, topics)
  for (const topic of enriched) {
    broadcastToProfileConnections(profileId, {
      type: 'topic_unread_count_changed',
      topicId: topic.topicId,
      unreadCount: topic.unreadCount,
    })
  }
}

// Perf audit follow-up: по-рано (дори след първия N+1 fix) тук имаше loop,
// викащ getTopicUnreadCountForProfile/getTopicThreadUnreadCountForProfile
// ВЕДНЪЖ на уникален profileId — O(uniqueProfiles) SQL statements per
// broadcast event (dedupe-нато спрямо connections, но не спрямо профили).
// При 60-100 едновременни различни directory-subscribers, това пак e
// десетки/стотици последователни sync SQLite execution-а.
//
// Двупроходен подход вместо това: (1) първи проход итерира connections само
// за да (a) изпълни per-connection WRITE side-effect-а
// (markTopicSeenForActiveProfile — остава явно per-connection, различни
// connections на same profile могат легитимно да имат различен
// activeTopicId), и (b) collect-не кои connections/profiles реално се
// нуждаят от READ+SEND (block/self-exclusion филтъра е приложен тук, преди
// batch call-а — изключените профили никога не влизат в batch заявката);
// (2) batch fetch на topic-level (getTopicUnreadCountsForProfiles) и
// thread-level (getTopicThreadUnreadCountsForProfiles) unread counts за
// ЦЕЛИЯ collected profile set наведнъж — фиксиран малък брой SQL statements,
// независим от profile count; (3) втори проход прави само map lookup +
// safeSendToConnection, нула SQL заявки.
function reconcileTopicUnreadForDirectorySubscribers(topicId: string, senderProfileId?: string, rootMessageId?: string): void {
  const topic = topicStore.getTopicById(topicId)

  type ReadRecipient = { connectionId: ConnectionId; profileId: string; needsThreadUnread: boolean }
  const readRecipients: ReadRecipient[] = []
  // Perf review follow-up: markTopicSeenForActiveProfile е идемпотентно —
  // upsert-ва до latestSeq и broadcast-ва до ВСИЧКИ connections на профила
  // (broadcastToProfileConnections), не само до тригериращата connection.
  // Ако same profile има >1 активна connection на този topic, второто
  // извикване би било byte-identical no-op work + duplicate broadcast към
  // същите sockets. Dedupe по profileId в рамките на този call премахва
  // тази излишна работа без да променя seen semantics.
  const markedSeenProfileIds = new Set<string>()

  for (const subscriberConnectionId of [...topicsDirectorySubscriberConnectionIds]) {
    const subscriberConnection = getConnectionById(serverState, subscriberConnectionId)
    const socket = socketRegistry.get(subscriberConnectionId)
    if (subscriberConnection === null || !socket || socket.readyState !== WebSocket.OPEN) {
      topicsDirectorySubscriberConnectionIds.delete(subscriberConnectionId)
      continue
    }
    const profileId = subscriberConnection.profileId
    if (profileId === null) continue

    const activeTopicId = topicMessageSubscriberTopicIdByConnectionId.get(subscriberConnectionId)
    if (activeTopicId === topicId && !topic?.isGeneral) {
      // Connection-specific WRITE — остава per-connection trigger, но
      // deduped по profileId (виж коментара по-горе).
      if (!markedSeenProfileIds.has(profileId)) {
        markedSeenProfileIds.add(profileId)
        markTopicSeenForActiveProfile(profileId, topicId)
      }
      continue
    }

    if (
      senderProfileId !== undefined &&
      (senderProfileId === profileId || getLobbyChatBlockedSet(profileId).has(senderProfileId))
    ) {
      continue
    }

    readRecipients.push({
      connectionId: subscriberConnectionId,
      profileId,
      needsThreadUnread: Boolean(topic?.isGeneral && rootMessageId !== undefined),
    })
  }

  if (readRecipients.length === 0) return

  const uniqueProfileIds = [...new Set(readRecipients.map((r) => r.profileId))]
  const excludedSendersByViewer = new Map<string, ReadonlySet<string>>(
    uniqueProfileIds.map((id) => [id, getLobbyChatBlockedSet(id)]),
  )

  const topicUnreadCountByProfileId = getTopicUnreadCountsForProfiles(topicId, uniqueProfileIds, excludedSendersByViewer)
  const threadUnreadCountByProfileId = (topic?.isGeneral && rootMessageId !== undefined)
    ? getTopicThreadUnreadCountsForProfiles(rootMessageId, uniqueProfileIds, excludedSendersByViewer)
    : null

  for (const recipient of readRecipients) {
    const topicUnreadCount = topicUnreadCountByProfileId.get(recipient.profileId) ?? 0
    safeSendToConnection(recipient.connectionId, {
      type: 'topic_unread_count_changed',
      topicId,
      unreadCount: topicUnreadCount,
    })
    if (recipient.needsThreadUnread && threadUnreadCountByProfileId !== null && rootMessageId !== undefined) {
      safeSendToConnection(recipient.connectionId, {
        type: 'topic_thread_unread_count_changed',
        topicId,
        rootMessageId,
        unreadCount: threadUnreadCountByProfileId.get(recipient.profileId) ?? 0,
        topicUnreadCount,
      })
    }
  }
}

// Public — всички subscribers на темата виждат lock/unlock realtime (виж
// брифа т.10: "composer/state се обновява без refresh"). Пълно текущо
// state (не delta), огледално на broadcastTopicMessageLikeChangedToLocalSubscribers.
function broadcastTopicLockStateChangedToLocalSubscribers(
  topicId: string,
  lockSnapshot: { isLocked: boolean; lockedUntil: string | null; lockedReason: string | null },
): void {
  const subscribers = topicMessageSubscribersByTopicId.get(topicId)
  if (subscribers === undefined || subscribers.size === 0) {
    return
  }
  for (const subscriberConnectionId of [...subscribers]) {
    safeSendToConnection(subscriberConnectionId, {
      type: 'topic_lock_state_changed',
      topicId,
      isLocked: lockSnapshot.isLocked,
      lockedUntil: lockSnapshot.lockedUntil,
      lockedReason: lockSnapshot.lockedReason,
    })
  }
}

// Public — subscribed клиенти трябва безопасно да се приберат в Topics
// directory (брифа т.10). Клиентът маха локалния subscription state при
// получаване, огледално на unsubscribe_topic_messages handling-а.
function broadcastTopicDeletedToLocalSubscribers(topicId: string): void {
  const subscribers = topicMessageSubscribersByTopicId.get(topicId)
  const notifiedConnectionIds = new Set<ConnectionId>()

  if (subscribers !== undefined && subscribers.size > 0) {
    for (const subscriberConnectionId of [...subscribers]) {
      safeSendToConnection(subscriberConnectionId, {
        type: 'topic_deleted',
        topicId,
      })
      notifiedConnectionIds.add(subscriberConnectionId)
      topicMessageSubscribersByTopicId.get(topicId)?.delete(subscriberConnectionId)
      if (topicMessageSubscriberTopicIdByConnectionId.get(subscriberConnectionId) === topicId) {
        topicMessageSubscriberTopicIdByConnectionId.delete(subscriberConnectionId)
      }
    }
  }

  // Directory-wide известяване — БЕЗ това, потребители, които в момента не
  // гледат точно тази тема (Lobby / Topics directory / друга тема), никога
  // не научават, че е изтрита: state.topics остава stale, aggregate badge-ът
  // (desktop "ТЕМИ"/mobile "Меню") показва фантомни непрочетени до следващ
  // пълен refresh (production bug, виж investigation report-а). Клиентският
  // 'topic_deleted' handler вече е безопасно generic (маха темата от
  // state.topics безусловно, допълнителна active-topic логика само ако е
  // била отворена) — просто разширяваме получателите.
  for (const directorySubscriberConnectionId of [...topicsDirectorySubscriberConnectionIds]) {
    if (notifiedConnectionIds.has(directorySubscriberConnectionId)) continue
    safeSendToConnection(directorySubscriberConnectionId, {
      type: 'topic_deleted',
      topicId,
    })
  }

  // Безусловен unread reconcile — огледално на
  // broadcastTopicMessageDeletedToLocalSubscribers (individual message
  // delete), НЕ зависи от subscribers.size на самата тема.
  reconcileTopicUnreadForDirectorySubscribers(topicId, undefined, undefined)
}

// Public broadcast при moderator delete на ОТДЕЛНО root съобщение или reply
// (individual-message moderation) — за разлика от broadcastTopicDeletedToLocalSubscribers
// по-горе, тук НЕ маха subscribers (темата остава напълно достъпна, само
// едно съобщение/thread изчезва). Reuse на СЪЩИЯ per-topic subscriber Set.
function broadcastTopicMessageDeletedToLocalSubscribers(
  topicId: string,
  messageId: string,
  parentMessageId: string | null,
  deletedAt: string,
): void {
  const subscribers = topicMessageSubscribersByTopicId.get(topicId)
  if (subscribers !== undefined && subscribers.size > 0) {
    for (const subscriberConnectionId of [...subscribers]) {
      safeSendToConnection(subscriberConnectionId, {
        type: 'topic_message_deleted',
        topicId,
        messageId,
        parentMessageId,
        deletedAt,
      })
    }
  }
  reconcileTopicUnreadForDirectorySubscribers(topicId, undefined, parentMessageId ?? messageId)
}

function broadcastTopicMessageEditedToLocalSubscribers(topicId: string, message: TopicMessageSnapshot): void {
  if (message.deletedAt !== null || message.editedAt === null) {
    return
  }

  const subscribers = topicMessageSubscribersByTopicId.get(topicId)
  if (subscribers === undefined || subscribers.size === 0) {
    return
  }

  for (const subscriberConnectionId of [...subscribers]) {
    const subscriberConnection = getConnectionById(serverState, subscriberConnectionId)
    const socket = socketRegistry.get(subscriberConnectionId)

    if (subscriberConnection === null || !socket || socket.readyState !== WebSocket.OPEN) {
      subscribers.delete(subscriberConnectionId)
      topicMessageSubscriberTopicIdByConnectionId.delete(subscriberConnectionId)
      continue
    }

    if (
      subscriberConnection.profileId !== null
      && getLobbyChatBlockedSet(subscriberConnection.profileId).has(message.senderProfileId)
    ) {
      continue
    }

    safeSendToConnection(subscriberConnectionId, {
      type: 'topic_message_edited',
      topicId,
      messageId: message.messageId,
      parentMessageId: message.parentMessageId,
      body: message.body,
      editedAt: message.editedAt,
    })
  }
}

// Target-only (private) — САМО до connections на заглушения/отглушения
// потребител, НЕ broadcast към всички subscribers (брифа т.10: "останалите
// клиенти не трябва да получават чувствителна/ненужна moderation
// информация"). scope='topics_section' (GLOBAL TOPICS MUTE брифа §12) —
// state-ът важи за ЦЯЛАТА секция "Теми", topicId е само audit context.
function notifyProfileOfTopicMuteStateChange(
  profileId: string,
  topicId: string,
  muteSnapshot: { isMuted: boolean; mutedUntil: string | null; reason: string | null },
): void {
  broadcastToProfileConnections(profileId, {
    type: 'topic_mute_state_changed',
    scope: 'topics_section',
    topicId,
    isMuted: muteSnapshot.isMuted,
    mutedUntil: muteSnapshot.mutedUntil,
    reason: muteSnapshot.reason,
  })
}

// Public, boolean-only broadcast (mute indicator icon брифа §7/§8) — до
// ВСИЧКИ connections, активно subscribe-нати за поне една Topics тема в
// момента (не само topicId контекста, от който е задействано действието —
// section-wide mute важи навсякъде, авторът може да има видими постове в
// няколко различни отворени теми едновременно). Малка, целенасочена
// итерация (реалният брой едновременни Topics viewers е малък) — не е
// heavy global reload/polling система. НЕ праща reason/mutedUntil/moderator
// identity — само boolean флаг, mirror на TopicProfileMuteStateChangedMessage
// коментара в протокола.
function broadcastTopicsSectionMuteIndicatorChange(profileId: string, isTopicsSectionMuted: boolean): void {
  const notifiedConnectionIds = new Set<ConnectionId>()
  for (const subscribers of topicMessageSubscribersByTopicId.values()) {
    for (const subscriberConnectionId of subscribers) {
      if (notifiedConnectionIds.has(subscriberConnectionId)) continue
      notifiedConnectionIds.add(subscriberConnectionId)
      safeSendToConnection(subscriberConnectionId, {
        type: 'topic_profile_mute_state_changed',
        profileId,
        isTopicsSectionMuted,
      })
    }
  }
}

// Lightweight aggregate drift-detection poll (Етап 3 cross-instance likes) —
// НЕ е seq-based invariant като root/reply poll-а. За всеки topicId с
// локални subscribers в момента, взима likeCount за message-ите, чийто
// count вече следим (topicMessageLikeLastKnownCountByMessageId), и
// broadcast-ва само реалните промени. Message-и влизат в tracking set-а
// когато local toggle се случи (виж toggle handler-а) — множество instances
// естествено се синхронизират, защото всеки от тях следи message-ите,
// toggle-нати НА НЕГО, и всеки клиент subscribe-ва към ЕДИН instance
// наведнъж (WS connection е sticky към конкретен process).
//
// Ограничение: ако instance B никога не е видял local toggle за дадено
// message (само instance A го toggle-ва), instance B никога няма да го
// добави в tracking set-а си и никога няма да poll-не/broadcast-не delta-та
// му към СВОИТЕ subscribers. Приемливо в рамките на Етап 3 scope, защото
// realtime like updates са needed само за viewers, гледащи message-а В
// МОМЕНТА — REST/canonical refresh (topic re-open, reconnect) винаги вижда
// коректния DB count независимо от tracking state-а. Виж Етап 3 плана,
// секция "Cross-instance strategy — Likes" за пълния trade-off rationale.
function runTopicMessageLikePoll(): void {
  if (isServerShuttingDown) return
  const now = Date.now()
  cleanupTopicMessageLikeRateLimitState(now)

  try {
    const trackedMessageIds = [...topicMessageLikeLastKnownCountByMessageId.keys()]
    if (trackedMessageIds.length > 0) {
      const currentCounts = topicMessageStore.getLikeCountsByMessageIds(trackedMessageIds)

      for (const messageId of trackedMessageIds) {
        const currentCount = currentCounts.get(messageId) ?? 0
        const knownCount = topicMessageLikeLastKnownCountByMessageId.get(messageId)

        // Same-instance echo suppression — ако ТОЗИ instance е toggle-нал
        // message-а наскоро, local-instant broadcast-ът вече е доставил
        // актуалния count; пропускаме, за да не дублираме съобщението.
        const announcedAt = topicMessageLikeLocallyAnnouncedAt.get(messageId)
        const recentlyLocallyAnnounced = announcedAt !== undefined && now - announcedAt < TOPIC_MESSAGE_LIKE_LOCALLY_ANNOUNCED_TTL_MS

        if (currentCount !== knownCount) {
          topicMessageLikeLastKnownCountByMessageId.set(messageId, currentCount)
          if (!recentlyLocallyAnnounced) {
            const targetMessage = topicMessageStore.getMessageById(messageId)
            if (targetMessage !== null) {
              broadcastTopicMessageLikeChangedToLocalSubscribers(targetMessage.topicId, messageId, currentCount)
            }
          }
        }
      }
    }

    for (const [messageId, announcedAt] of topicMessageLikeLocallyAnnouncedAt.entries()) {
      if (now - announcedAt >= TOPIC_MESSAGE_LIKE_LOCALLY_ANNOUNCED_TTL_MS) {
        topicMessageLikeLocallyAnnouncedAt.delete(messageId)
      }
    }
  } catch (error) {
    console.error('[topics] like drift-detection poll failed:', error)
  }
}

let topicMessageLikePollInterval: ReturnType<typeof setInterval> | null = setInterval(
  runTopicMessageLikePoll,
  TOPIC_MESSAGE_LIKE_POLL_INTERVAL_MS,
)

// Startup baseline = текущия getMaxSeq() — НЕ 0 — за да не се replay-ва
// цялата историческа topic_messages таблица към local subscribers след
// рестарт на процеса (Етап 2 брифа т.2). Historical gap-ове за КОНКРЕТЕН
// client се възстановяват чрез afterSeq catch-up при subscribe / REST, НЕ
// чрез replay на цялата DB от global poll-а.
let topicMessagePollCursor = topicMessageStore.getMaxSeq()

// seq -> кога е бил broadcast-нат локално от ТОЗИ instance при insert. Poll
// tick-ът чете тази карта, за да прескочи ВТОРИ broadcast на съобщение, което
// собствения local send path вече е доставил instant-но (виж инвариант
// коментара най-горе на секцията). Bounded: prune-нато след всеки poll tick
// (всичко seq <= новия cursor вече е "видяно" от poll-а) + hard TTL safety
// net в случай poll-ът някога спре да тиктака.
const topicMessageLocallyAnnouncedSeqs = new Map<number, number>()

// Individual message/reply moderation delete — cross-instance fanout cursor
// (mirror на lobbyChatLastAnnouncedDeletionEventSeq). Startup baseline =
// getMaxDeletionEventSeq() — НЕ 0 — за да няма historical replay след
// restart (established топик message poll invariant, виж topicMessagePollCursor
// коментара по-горе).
let topicMessageLastAnnouncedDeletionEventSeq = topicMessageStore.getMaxDeletionEventSeq()
let topicMessageLastAnnouncedEditEventSeq = topicMessageStore.getMaxEditEventSeq()

function pruneTopicMessageLocallyAnnouncedSeqs(now: number): void {
  for (const [seq, announcedAt] of topicMessageLocallyAnnouncedSeqs.entries()) {
    if (seq <= topicMessagePollCursor || now - announcedAt >= TOPIC_MESSAGE_LOCALLY_ANNOUNCED_TTL_MS) {
      topicMessageLocallyAnnouncedSeqs.delete(seq)
    }
  }
}

function runTopicMessagesCrossInstancePoll(): void {
  if (isServerShuttingDown) {
    return
  }

  const tickStartedAtMs = performance.now()
  try {
    runTopicMessagesCrossInstancePollUnsafe()
  } finally {
    backgroundJobMetrics.record('topicPoll', performance.now() - tickStartedAtMs)
  }
}

function runTopicMessagesCrossInstancePollUnsafe(): void {
  const now = Date.now()
  cleanupTopicMessageRateLimitState(now)

  try {
    const rows = topicMessageStore.pollNewMessages(topicMessagePollCursor, TOPIC_MESSAGE_POLL_BATCH_SIZE)

    // Чист invariant helper (server/src/realtime/topicMessagePollAdvance.ts,
    // независимо unit-тестван) — cursor напредва за ВСЕКИ прочетен ред,
    // независимо дали е locally-announced; виж коментара при декларацията
    // на topicMessagePollCursor по-горе за пълния race rationale.
    const { nextCursor, rowsToBroadcast } = computeTopicMessagePollAdvance(
      topicMessagePollCursor,
      new Set(topicMessageLocallyAnnouncedSeqs.keys()),
      rows,
    )
    topicMessagePollCursor = nextCursor

    // ЕДНО batch hydration извикване за целия tick, независимо от броя
    // различни теми/автори/root-или-reply в rowsToBroadcast — виж коментара
    // над hydrateTopicMessagesWithCurrentAvatars (Етап 2 брифа т.3, Етап 3
    // разширение). Разклоняваме по parentMessageId ПОСЛЕ hydration-а (не
    // преди) — една batch заявка обслужва и root, и reply редове наведнъж.
    if (rowsToBroadcast.length > 0) {
      const hydrated = hydrateTopicMessagesWithCurrentAvatars(rowsToBroadcast)
      for (const message of hydrated) {
        // Seed-ва like drift-detection tracking set-а (runTopicMessageLikePoll)
        // за ВСЯКО ново root/reply, видяно от poll-а — не само чрез
        // subscribe catch-up (виж коментара там). Без това, root/reply
        // insert-нат СЛЕД subscribe-а на дадена инстанция никога не влиза в
        // tracking set-а ѝ, и likes върху него никога не се synchronize-ват
        // cross-instance (виж checkTopicRepliesLikesRealtime.ts [Cross-Like]).
        if (!topicMessageLikeLastKnownCountByMessageId.has(message.messageId)) {
          topicMessageLikeLastKnownCountByMessageId.set(message.messageId, message.likeCount)
        }
        if (message.parentMessageId === null) {
          broadcastTopicMessageToLocalSubscribers(message.topicId, message)
        } else {
          const { replyCount: _replyCount, ...replyBase } = message
          broadcastTopicReplyToLocalSubscribers(message.topicId, { ...replyBase, parentMessageId: message.parentMessageId })
        }
      }
    }
  } catch (error) {
    console.error('[topics] cross-instance message poll failed:', error)
  }

  // Individual message/reply moderation delete — deletion-event poll, СЪЩИЯТ
  // tick, отделен monotonic cursor (mirror на runLobbyChatCrossInstancePoll,
  // който прави и двете стъпки в 1 interval, не отделен нов timer — брифа
  // §16/§24). Local-instance delete-ите вече са broadcast-нати instant-но от
  // handleTopicMessageDeleteRequest (виж topicMessageLastAnnouncedDeletionEventSeq
  // bump-а там) — тук напредваме cursor-а покрай тях без ВТОРИ broadcast,
  // но НЕ пропускаме foreign (друга инстанция) deletion events.
  try {
    const deletionEvents = topicMessageStore.pollMessageDeletionEvents(
      topicMessageLastAnnouncedDeletionEventSeq,
      TOPIC_MESSAGE_POLL_BATCH_SIZE,
    )
    for (const event of deletionEvents) {
      topicMessageLastAnnouncedDeletionEventSeq = Math.max(topicMessageLastAnnouncedDeletionEventSeq, event.eventSeq)
      const targetRow = topicMessageStore.getMessageById(event.messageId)
      broadcastTopicMessageDeletedToLocalSubscribers(
        event.topicId,
        event.messageId,
        event.parentMessageId,
        targetRow?.deletedAt ?? new Date().toISOString(),
      )
    }
  } catch (error) {
    console.error('[topics] cross-instance message deletion poll failed:', error)
  }

  try {
    const editEvents = topicMessageStore.pollMessageEditEvents(
      topicMessageLastAnnouncedEditEventSeq,
      TOPIC_MESSAGE_POLL_BATCH_SIZE,
    )
    for (const event of editEvents) {
      topicMessageLastAnnouncedEditEventSeq = Math.max(topicMessageLastAnnouncedEditEventSeq, event.eventSeq)
      const targetRow = topicMessageStore.getMessageById(event.messageId)
      if (targetRow !== null && targetRow.topicId === event.topicId && targetRow.deletedAt === null) {
        broadcastTopicMessageEditedToLocalSubscribers(event.topicId, targetRow)
      }
    }
  } catch (error) {
    console.error('[topics] cross-instance message edit poll failed:', error)
  }

  pruneTopicMessageLocallyAnnouncedSeqs(now)
}

let topicMessagePollInterval: ReturnType<typeof setInterval> | null = setInterval(
  runTopicMessagesCrossInstancePoll,
  LOBBY_CHAT_POLL_INTERVAL_MS,
)

// ─── "Теми" (Topics) realtime — създаване на нова тема (Custom Topic
// Creation) ──────────────────────────────────────────────────────────────
//
// Same instant-local-broadcast + cross-instance-poll модел като root
// съобщенията по-горе, но опростен — topic creation е рядко действие (не
// high-volume chat), затова НЕ се нуждае от locally-announced echo
// suppression set: directory upsert-ва по topicId client-side (виж
// TopicCreatedMessage коментара в messageTypes.ts), значи дори ако
// creator-ът получи и direct success, И собствения си broadcast (edge-case
// timing), клиентът просто overwrite-ва СЪЩИЯ topicId — безвредно.
//
// Cursor: composite (createdAt, topicId), виж
// topicStore.pollNewActiveTopicsCreatedAfter коментара — 'topics' няма
// auto-increment seq като topic_messages.

const TOPIC_CREATE_RATE_LIMIT_WINDOW_MS = 60_000
const TOPIC_CREATE_RATE_LIMIT_MAX_PER_WINDOW = 3
const TOPIC_CREATE_RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000
const TOPICS_DIRECTORY_POLL_INTERVAL_MS = 2_000
const TOPICS_DIRECTORY_POLL_BATCH_SIZE = 50

type TopicCreateRateLimitEntry = { count: number; windowStartedAt: number }
// Отделен bucket от topicMessageRateLimitByProfileId — създаването на теми е
// различно, по-рядко действие от писането на съобщения, не бива да дели
// budget с тях.
const topicCreateRateLimitByProfileId = new Map<string, TopicCreateRateLimitEntry>()
let topicCreateRateLimitLastCleanupAt = 0

function checkTopicCreateRateLimit(profileId: string, now: number = Date.now()): boolean {
  const existing = topicCreateRateLimitByProfileId.get(profileId)

  if (!existing || now - existing.windowStartedAt >= TOPIC_CREATE_RATE_LIMIT_WINDOW_MS) {
    topicCreateRateLimitByProfileId.set(profileId, { count: 1, windowStartedAt: now })
    return true
  }

  if (existing.count >= TOPIC_CREATE_RATE_LIMIT_MAX_PER_WINDOW) {
    return false
  }

  existing.count += 1
  return true
}

function cleanupTopicCreateRateLimitState(now: number): void {
  if (now - topicCreateRateLimitLastCleanupAt < TOPIC_CREATE_RATE_LIMIT_CLEANUP_INTERVAL_MS) {
    return
  }
  topicCreateRateLimitLastCleanupAt = now
  for (const [profileId, entry] of topicCreateRateLimitByProfileId.entries()) {
    if (now - entry.windowStartedAt >= TOPIC_CREATE_RATE_LIMIT_WINDOW_MS) {
      topicCreateRateLimitByProfileId.delete(profileId)
    }
  }
}

function broadcastTopicCreatedToLocalSubscribers(
  topic: TopicSnapshot,
  opts?: { originatingConnectionId?: ConnectionId },
): void {
  for (const subscriberConnectionId of [...topicsDirectorySubscriberConnectionIds]) {
    // Originator-ът вече получи ОТДЕЛЕН requestId-matched success response
    // (виж create_topic handler-а) — за разлика от lobby chat/topic
    // message broadcast (където originator-ът е subscriber И самата
    // broadcast функция носи неговия requestId в СЪЩИЯ пакет), тук directno
    // skip-ваме originator connection-а изцяло, за да не получи ВТОРИ
    // 'topic_created' пакет (би създало duplicate-append риск client-side,
    // spec изисква "success + broadcast да не създадат duplicate chip").
    if (opts?.originatingConnectionId === subscriberConnectionId) {
      continue
    }

    const subscriberConnection = getConnectionById(serverState, subscriberConnectionId)
    const socket = socketRegistry.get(subscriberConnectionId)

    if (subscriberConnection === null || !socket || socket.readyState !== WebSocket.OPEN) {
      topicsDirectorySubscriberConnectionIds.delete(subscriberConnectionId)
      continue
    }

    safeSendToConnection(subscriberConnectionId, {
      type: 'topic_created',
      topic,
    })
  }
}

// Startup baseline = rowid на последната ВЕЧЕ съществуваща тема — НЕ '0' —
// за да не се replay-ва цялата историческа topics таблица към local
// subscribers след рестарт на процеса (established convention, mirror на
// topicMessagePollCursor баселайна).
let topicsDirectoryPollCursor: string = topicStore.getLatestActiveTopicCursor()

function runTopicsDirectoryCrossInstancePoll(): void {
  if (isServerShuttingDown) {
    return
  }

  cleanupTopicCreateRateLimitState(Date.now())

  try {
    const { topics: newTopics, nextCursor } = topicStore.pollNewActiveTopicsCreatedAfter(topicsDirectoryPollCursor, TOPICS_DIRECTORY_POLL_BATCH_SIZE)
    topicsDirectoryPollCursor = nextCursor
    for (const topic of newTopics) {
      broadcastTopicCreatedToLocalSubscribers(topic)
    }
  } catch (error) {
    console.error('[topics] directory cross-instance poll failed:', error)
  }
}

let topicsDirectoryPollInterval: ReturnType<typeof setInterval> | null = setInterval(
  runTopicsDirectoryCrossInstancePoll,
  TOPICS_DIRECTORY_POLL_INTERVAL_MS,
)

// ─── Личен чат — attachment cleanup ─────────────────────────────────────────
//
// Два отделни job-а:
// 1) runChatAttachmentCleanup — обработва friend_chat_attachment_deletions
//    (deletion-intent записи от chatStore prune-а при 500-съобщения лимита,
//    виж chatStore.sendMessage) — бърз, чест, малък batch.
// 2) runChatAttachmentOrphanScan — по-рядък defensive scan: сравнява
//    файловете на диска срещу DB, трие файлове без НИКАКЪВ DB запис (напр.
//    ако upload е паднал точно между file write и DB insert, а deletion
//    queue записът не е могъл да се създаде, защото DB транзакцията никога
//    не е стартирала). grace period предпазва in-flight upload-и.
async function runChatAttachmentCleanup(): Promise<void> {
  if (isServerShuttingDown) {
    return
  }

  try {
    const pending = chatStore.listPendingAttachmentDeletions(CHAT_ATTACHMENT_CLEANUP_BATCH_SIZE)

    if (pending.length === 0) {
      return
    }

    let deletedCount = 0
    let failedCount = 0

    for (const entry of pending) {
      // Defensive: ако файлът вече принадлежи на друг, по-нов attachment
      // запис (теоретично невъзможно заради UNIQUE storage_filename, но
      // проверяваме explicit преди физическо изтриване, за да никога не
      // трием файл, който все още е активно свързан с валидно съобщение).
      if (chatStore.attachmentExistsForFilename(entry.storageFilename)) {
        chatStore.markAttachmentDeletionDone(entry.eventSeq)
        continue
      }

      const deleted = await deleteChatAttachmentFileByFilename(entry.storageFilename)

      if (deleted) {
        chatStore.markAttachmentDeletionDone(entry.eventSeq)
        deletedCount += 1
      } else {
        chatStore.markAttachmentDeletionFailed(entry.eventSeq)
        failedCount += 1
      }
    }

    if (deletedCount > 0 || failedCount > 0) {
      console.log(`[chat-attachments] Cleanup: deleted=${deletedCount} failed=${failedCount}`)
    }
  } catch (error) {
    console.error('[chat-attachments] Cleanup failed:', error)
  }
}

async function runChatAttachmentOrphanScan(): Promise<void> {
  if (isServerShuttingDown) {
    return
  }

  try {
    await mkdir(CHAT_ATTACHMENT_UPLOADS_PATH, { recursive: true })
    const entries = await readdir(CHAT_ATTACHMENT_UPLOADS_PATH, { withFileTypes: true })
    const now = Date.now()
    let deletedCount = 0

    for (const entry of entries) {
      if (isServerShuttingDown) {
        return
      }

      if (!entry.isFile() || !IMAGE_ATTACHMENT_FILENAME_PATTERN.test(entry.name)) {
        continue
      }

      // Никога не трием файл, който все още присъства във
      // friend_chat_attachments — това е финалният, авторитетен guard
      // (изисквано изрично: "никога да не изтрива файл, който все още е
      // свързан с валидно чат съобщение").
      if (chatStore.attachmentExistsForFilename(entry.name)) {
        continue
      }

      const filePath = join(CHAT_ATTACHMENT_UPLOADS_PATH, entry.name)

      try {
        const fileStats = await stat(filePath)

        if (now - fileStats.mtimeMs < CHAT_ATTACHMENT_ORPHAN_GRACE_PERIOD_MS) {
          // Твърде "прясен" — може да е in-flight upload (файлът е записан,
          // но DB транзакцията все още не е committed). Пропускаме до
          // следващия scan цикъл.
          continue
        }
      } catch {
        continue
      }

      const deleted = await deleteChatAttachmentFileByFilename(entry.name)
      if (deleted) {
        deletedCount += 1
      }
    }

    if (deletedCount > 0) {
      console.log(`[chat-attachments] Orphan scan: deleted ${deletedCount} orphaned file(s)`)
    }

    // Завършените (done) deletion-queue записи не се трият автоматично при
    // отбелязването им — без този purge friend_chat_attachment_deletions
    // би растяла неограничено. Вградено тук (по-рядкия 6ч job), не в
    // честия 5-мин cleanup, за да не удря SQL всеки цикъл. failed записите
    // НЕ се пипат от purge-а — те продължават да се преоценяват от
    // runChatAttachmentCleanup (виж cleanup_status IN ('pending','failed')).
    const purgedDeletionEvents = chatStore.purgeDoneAttachmentDeletions(
      CHAT_ATTACHMENT_DELETION_EVENT_RETENTION_DAYS,
      CHAT_ATTACHMENT_CLEANUP_BATCH_SIZE,
    )
    if (purgedDeletionEvents > 0) {
      console.log(`[chat-attachments] Purged ${purgedDeletionEvents} completed deletion-queue row(s)`)
    }
  } catch (error) {
    console.error('[chat-attachments] Orphan scan failed:', error)
  }
}

let chatAttachmentCleanupStartupTimeout: ReturnType<typeof setTimeout> | null = setTimeout(
  () => { void runChatAttachmentCleanup() },
  CHAT_ATTACHMENT_CLEANUP_STARTUP_DELAY_MS,
)
let chatAttachmentCleanupInterval: ReturnType<typeof setInterval> | null = setInterval(
  () => { void runChatAttachmentCleanup() },
  CHAT_ATTACHMENT_CLEANUP_INTERVAL_MS,
)
let chatAttachmentOrphanScanStartupTimeout: ReturnType<typeof setTimeout> | null = setTimeout(
  () => { void runChatAttachmentOrphanScan() },
  CHAT_ATTACHMENT_ORPHAN_SCAN_STARTUP_DELAY_MS,
)
let chatAttachmentOrphanScanInterval: ReturnType<typeof setInterval> | null = setInterval(
  () => { void runChatAttachmentOrphanScan() },
  CHAT_ATTACHMENT_ORPHAN_SCAN_INTERVAL_MS,
)
const yellowCoinGiftStore = await createYellowCoinGiftStore(
  databaseBootstrap.databaseFilePath,
  playerProgressStore,
  adminSettingsStore,
)
const tableExitPenaltyStore = await createTableExitPenaltyStore(
  databaseBootstrap.databaseFilePath,
  playerProgressStore,
)
const matchRoomsStore = await createMatchRoomsStore(databaseBootstrap.databaseFilePath)
setSupportedMatchStakes(matchRoomsStore.getEnabledStakes())
setMatchPrizeResolver((stake) => matchRoomsStore.getPrizeAmount(stake))

const matchEconomyStore = await createMatchEconomyStore(databaseBootstrap.databaseFilePath)
const vipStore = await createVipStore(databaseBootstrap.databaseFilePath)
const vipPurchaseStore = await createVipPurchaseStore(databaseBootstrap.databaseFilePath)
const missionStore = await createMissionStore(databaseBootstrap.databaseFilePath)
const supportStore = await createSupportStore(databaseBootstrap.databaseFilePath)
const guestContactStore = await createGuestContactStore(databaseBootstrap.databaseFilePath)
const guestTrialStore = await createGuestTrialStore(databaseBootstrap.databaseFilePath)
const siteVisitStore = await createSiteVisitStore(databaseBootstrap.databaseFilePath)

// Password reset store — optional. Ако env липсва, store-ът е null и само
// forgot/reset endpoints връщат EMAIL_DELIVERY_FAILED. Останалият server работи.
let passwordResetStore: PasswordResetStore | null = null
let passwordResetUrl: string = ''
{
  const rateLimitSecret = process.env.PASSWORD_RESET_RATE_LIMIT_SECRET?.trim() ?? ''
  const resetUrl = process.env.PASSWORD_RESET_URL?.trim() ?? ''
  if (rateLimitSecret.length >= 32 && resetUrl.length > 0) {
    try {
      passwordResetStore = await createPasswordResetStore(databaseBootstrap.databaseFilePath, {
        rateLimitHashSecret: rateLimitSecret,
      })
      passwordResetUrl = resetUrl
      console.log('[password-reset] Store initialized.')
    } catch (error) {
      console.error('[password-reset] Store init failed — forgot/reset endpoints unavailable:', error)
    }
  } else {
    console.warn('[password-reset] PASSWORD_RESET_URL or PASSWORD_RESET_RATE_LIMIT_SECRET not configured — forgot/reset endpoints unavailable.')
  }
}

function runSiteVisitRetentionCleanup(): void {
  if (isServerShuttingDown) {
    return
  }

  try {
    const result = siteVisitStore.purgeOlderThanDays(SITE_VISIT_RETENTION_DAYS)
    if (result.deletedEvents > 0 || result.deletedVisitors > 0) {
      console.log(
        `[visits] Retention cleanup: deleted events=${result.deletedEvents} orphanVisitors=${result.deletedVisitors}`,
      )
    }
  } catch (error) {
    console.error('[visits] Retention cleanup failed:', error)
  }
}

siteVisitRetentionStartupTimeout = setTimeout(
  runSiteVisitRetentionCleanup,
  SITE_VISIT_RETENTION_STARTUP_DELAY_MS,
)
siteVisitRetentionInterval = setInterval(
  runSiteVisitRetentionCleanup,
  SITE_VISIT_RETENTION_INTERVAL_MS,
)

function runSupportCleanup(): void {
  if (isServerShuttingDown) {
    return
  }

  const deleted = supportStore.cleanupInactiveConversations()
  if (deleted > 0) {
    console.log(`[support] Cleanup: deleted ${deleted} messages from inactive resolved conversations`)
  }
}
runSupportCleanup()
supportCleanupInterval = setInterval(runSupportCleanup, 24 * 60 * 60 * 1000)

async function runSupportAttachmentCleanup(): Promise<void> {
  if (isServerShuttingDown) {
    return
  }

  try {
    const pending = supportStore.listPendingAttachmentDeletions(SUPPORT_ATTACHMENT_CLEANUP_BATCH_SIZE)

    if (pending.length === 0) {
      return
    }

    let deletedCount = 0
    let failedCount = 0

    for (const entry of pending) {
      if (supportStore.attachmentExistsForFilename(entry.storageFilename)) {
        supportStore.markAttachmentDeletionDone(entry.eventSeq)
        continue
      }

      const deleted = await deleteSupportAttachmentFileByFilename(entry.storageFilename)

      if (deleted) {
        supportStore.markAttachmentDeletionDone(entry.eventSeq)
        deletedCount += 1
      } else {
        supportStore.markAttachmentDeletionFailed(entry.eventSeq)
        failedCount += 1
      }
    }

    if (deletedCount > 0 || failedCount > 0) {
      console.log(`[support-attachments] Cleanup: deleted=${deletedCount} failed=${failedCount}`)
    }
  } catch (error) {
    console.error('[support-attachments] Cleanup failed:', error)
  }
}

async function runSupportAttachmentOrphanScan(): Promise<void> {
  if (isServerShuttingDown) {
    return
  }

  try {
    await mkdir(SUPPORT_ATTACHMENT_UPLOADS_PATH, { recursive: true })
    const entries = await readdir(SUPPORT_ATTACHMENT_UPLOADS_PATH, { withFileTypes: true })
    const now = Date.now()
    let deletedCount = 0

    for (const entry of entries) {
      if (isServerShuttingDown) {
        return
      }

      if (!entry.isFile() || !IMAGE_ATTACHMENT_FILENAME_PATTERN.test(entry.name)) {
        continue
      }

      if (supportStore.attachmentExistsForFilename(entry.name)) {
        continue
      }

      const filePath = join(SUPPORT_ATTACHMENT_UPLOADS_PATH, entry.name)

      try {
        const fileStats = await stat(filePath)

        if (now - fileStats.mtimeMs < SUPPORT_ATTACHMENT_ORPHAN_GRACE_PERIOD_MS) {
          continue
        }
      } catch {
        continue
      }

      const deleted = await deleteSupportAttachmentFileByFilename(entry.name)
      if (deleted) {
        deletedCount += 1
      }
    }

    if (deletedCount > 0) {
      console.log(`[support-attachments] Orphan scan: deleted ${deletedCount} orphaned file(s)`)
    }

    const purgedDeletionEvents = supportStore.purgeDoneAttachmentDeletions(
      SUPPORT_ATTACHMENT_DELETION_EVENT_RETENTION_DAYS,
      SUPPORT_ATTACHMENT_CLEANUP_BATCH_SIZE,
    )
    if (purgedDeletionEvents > 0) {
      console.log(`[support-attachments] Purged ${purgedDeletionEvents} completed deletion-queue row(s)`)
    }
  } catch (error) {
    console.error('[support-attachments] Orphan scan failed:', error)
  }
}

let supportAttachmentCleanupStartupTimeout: ReturnType<typeof setTimeout> | null = setTimeout(
  () => { void runSupportAttachmentCleanup() },
  SUPPORT_ATTACHMENT_CLEANUP_STARTUP_DELAY_MS,
)
let supportAttachmentCleanupInterval: ReturnType<typeof setInterval> | null = setInterval(
  () => { void runSupportAttachmentCleanup() },
  SUPPORT_ATTACHMENT_CLEANUP_INTERVAL_MS,
)
let supportAttachmentOrphanScanStartupTimeout: ReturnType<typeof setTimeout> | null = setTimeout(
  () => { void runSupportAttachmentOrphanScan() },
  SUPPORT_ATTACHMENT_ORPHAN_SCAN_STARTUP_DELAY_MS,
)
let supportAttachmentOrphanScanInterval: ReturnType<typeof setInterval> | null = setInterval(
  () => { void runSupportAttachmentOrphanScan() },
  SUPPORT_ATTACHMENT_ORPHAN_SCAN_INTERVAL_MS,
)

// "Теми" attachment cleanup — трети независим job чифт, reuse на СЪЩИЯ модел
// (deletion queue + defensive orphan scan) като chat/support по-горе.
async function runTopicAttachmentCleanup(): Promise<void> {
  if (isServerShuttingDown) {
    return
  }

  try {
    const pending = topicMessageStore.listPendingAttachmentDeletions(TOPIC_ATTACHMENT_CLEANUP_BATCH_SIZE)

    if (pending.length === 0) {
      return
    }

    let deletedCount = 0
    let failedCount = 0

    for (const entry of pending) {
      // Defensive: ако файлът вече принадлежи на друг, по-нов attachment
      // запис (теоретично невъзможно заради UNIQUE storage_filename, но
      // проверяваме explicit преди физическо изтриване, за да никога не
      // трием файл, който все още е активно свързан с валидно съобщение) —
      // mirror на runChatAttachmentCleanup/runSupportAttachmentCleanup.
      // Topics вече е hard-delete модел за attachments (whole-topic delete
      // изтрива topic_message_attachments веднага, не soft-delete) — same
      // reference-existence семантика като chat/support, не live-JOIN.
      if (topicMessageStore.attachmentExistsForFilename(entry.storageFilename)) {
        topicMessageStore.markAttachmentDeletionDone(entry.eventSeq)
        continue
      }

      const deleted = await deleteTopicAttachmentFileByFilename(entry.storageFilename)

      if (deleted) {
        topicMessageStore.markAttachmentDeletionDone(entry.eventSeq)
        deletedCount += 1
      } else {
        topicMessageStore.markAttachmentDeletionFailed(entry.eventSeq)
        failedCount += 1
      }
    }

    if (deletedCount > 0 || failedCount > 0) {
      console.log(`[topic-attachments] Cleanup: deleted=${deletedCount} failed=${failedCount}`)
    }
  } catch (error) {
    console.error('[topic-attachments] Cleanup failed:', error)
  }
}

async function runTopicAttachmentOrphanScan(): Promise<void> {
  if (isServerShuttingDown) {
    return
  }

  try {
    await mkdir(TOPIC_ATTACHMENT_UPLOADS_PATH, { recursive: true })
    const entries = await readdir(TOPIC_ATTACHMENT_UPLOADS_PATH, { withFileTypes: true })
    const now = Date.now()
    let deletedCount = 0

    for (const entry of entries) {
      if (isServerShuttingDown) {
        return
      }

      if (!entry.isFile() || !IMAGE_ATTACHMENT_FILENAME_PATTERN.test(entry.name)) {
        continue
      }

      // reference-existence проверка (mirror на runTopicAttachmentCleanup по-горе
      // и chat/support orphan scan-овете) — hard-delete модел, DB row
      // presence е достатъчен canonical сигнал за "все още нужен".
      if (topicMessageStore.attachmentExistsForFilename(entry.name)) {
        continue
      }

      const filePath = join(TOPIC_ATTACHMENT_UPLOADS_PATH, entry.name)

      try {
        const fileStats = await stat(filePath)

        if (now - fileStats.mtimeMs < TOPIC_ATTACHMENT_ORPHAN_GRACE_PERIOD_MS) {
          continue
        }
      } catch {
        continue
      }

      const deleted = await deleteTopicAttachmentFileByFilename(entry.name)
      if (deleted) {
        deletedCount += 1
      }
    }

    if (deletedCount > 0) {
      console.log(`[topic-attachments] Orphan scan: deleted ${deletedCount} orphaned file(s)`)
    }

    const purgedDeletionEvents = topicMessageStore.purgeDoneAttachmentDeletions(
      TOPIC_ATTACHMENT_DELETION_EVENT_RETENTION_DAYS,
      TOPIC_ATTACHMENT_CLEANUP_BATCH_SIZE,
    )
    if (purgedDeletionEvents > 0) {
      console.log(`[topic-attachments] Purged ${purgedDeletionEvents} completed deletion-queue row(s)`)
    }
  } catch (error) {
    console.error('[topic-attachments] Orphan scan failed:', error)
  }
}

let topicAttachmentCleanupStartupTimeout: ReturnType<typeof setTimeout> | null = setTimeout(
  () => { void runTopicAttachmentCleanup() },
  TOPIC_ATTACHMENT_CLEANUP_STARTUP_DELAY_MS,
)
let topicAttachmentCleanupInterval: ReturnType<typeof setInterval> | null = setInterval(
  () => { void runTopicAttachmentCleanup() },
  TOPIC_ATTACHMENT_CLEANUP_INTERVAL_MS,
)
let topicAttachmentOrphanScanStartupTimeout: ReturnType<typeof setTimeout> | null = setTimeout(
  () => { void runTopicAttachmentOrphanScan() },
  TOPIC_ATTACHMENT_ORPHAN_SCAN_STARTUP_DELAY_MS,
)
let topicAttachmentOrphanScanInterval: ReturnType<typeof setInterval> | null = setInterval(
  () => { void runTopicAttachmentOrphanScan() },
  TOPIC_ATTACHMENT_ORPHAN_SCAN_INTERVAL_MS,
)

// ─── Removed Topics — 180-day retention final purge ─────────────────────────
//
// Продуктово решение (corrective pass): изтрита (removed) тема пази текстовото
// си съдържание (topic row, root messages, replies, likes, mutes, reports)
// точно 180 дни от `topics.removed_at` (authoritative anchor, НЕ created_at,
// НЕ message deleted_at) — за модерационна справка. Attachments вече са
// hard-deleted веднага при самия delete (deleteTopic), не участват тук.
// Daily cadence е достатъчна за 180-дневен прозорец (established convention,
// mirror на LOBBY_CHAT_RETENTION_INTERVAL_MS/STARTUP_DELAY_MS по-горе) — без
// нужда от minute-level polling.
const TOPIC_RETENTION_DAYS = 180
const TOPIC_RETENTION_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000
const TOPIC_RETENTION_PURGE_STARTUP_DELAY_MS = 60 * 1000
const TOPIC_RETENTION_PURGE_BATCH_SIZE = 200

function runTopicRetentionPurge(): void {
  if (isServerShuttingDown) {
    return
  }

  try {
    const cutoff = new Date(Date.now() - TOPIC_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    const purgedCount = topicModerationStore.purgeRemovedTopicsBefore(cutoff, TOPIC_RETENTION_PURGE_BATCH_SIZE)
    if (purgedCount > 0) {
      console.log(`[topics] Retention purge: hard-deleted ${purgedCount} removed topic(s) older than ${TOPIC_RETENTION_DAYS} days`)
    }
  } catch (error) {
    console.error('[topics] Retention purge failed:', error)
  }

  // Individual message/reply moderation delete — СЪЩИЯТ maintenance cycle,
  // отделен bounded purge (mirror на whole-topic purge-а по-горе, но
  // anchored от topic_messages.deleted_at, НЕ topics.removed_at). Изключва
  // съобщения от removed теми explicitly — whole-topic purge-ът по-горе е
  // authoritative там (individual-message-moderation брифа §3/§22/§24, не
  // два competing purge lifecycle-а за една и съща removed тема).
  try {
    const messageCutoff = new Date(Date.now() - TOPIC_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    const purgedMessageCount = topicMessageStore.purgeDeletedTopicMessagesBefore(messageCutoff, TOPIC_RETENTION_PURGE_BATCH_SIZE)
    if (purgedMessageCount > 0) {
      console.log(`[topics] Retention purge: hard-deleted ${purgedMessageCount} individually-moderated message(s)/reply(s) older than ${TOPIC_RETENTION_DAYS} days`)
    }
  } catch (error) {
    console.error('[topics] Individual message retention purge failed:', error)
  }
}

let topicRetentionPurgeStartupTimeout: ReturnType<typeof setTimeout> | null = setTimeout(
  runTopicRetentionPurge,
  TOPIC_RETENTION_PURGE_STARTUP_DELAY_MS,
)
let topicRetentionPurgeInterval: ReturnType<typeof setInterval> | null = setInterval(
  runTopicRetentionPurge,
  TOPIC_RETENTION_PURGE_INTERVAL_MS,
)

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
  return 24 * 60 * 60 * 1000 - elapsedMs + 1000
}

function scheduleMidnightMissionRotation(): void {
  if (isServerShuttingDown) {
    return
  }

  const delay = msUntilNextSofiaMidnight()
  console.log(`[missions] Next midnight rotation in ${Math.round(delay / 60000)} min`)
  missionRotationTimeout = setTimeout(() => {
    missionRotationTimeout = null

    if (isServerShuttingDown) {
      return
    }

    console.log('[missions] Midnight rotation: running')
    missionStore.maybePromoteStaged()
    scheduleMidnightMissionRotation()
  }, delay)
}
scheduleMidnightMissionRotation()

console.log(
  `[db] SQLite ready file=${databaseBootstrap.databaseFilePath} applied=${databaseBootstrap.appliedCount} skipped=${databaseBootstrap.skippedCount}`,
)
console.log(
  `[db] bot catalog import processed=${botCatalogImport.processedCount} inserted=${botCatalogImport.insertedCount} updated=${botCatalogImport.updatedCount}`,
)

type ResumeRoomResult =
  | {
      ok: true
      room: ServerRoom
      seat: Seat
    }
  | {
      ok: false
      message: string
    }

function isRuntimeAuthoritativeState(
  value: ServerRoom['game']['authoritativeState'],
): value is ServerAuthoritativeGameState {
  return value !== null && 'phase' in value
}

function prepareRestoredRoomForServerStart(
  room: ServerRoom,
  now: number,
): ServerRoom {
  const nextSeats: ServerRoom['seats'] = { ...room.seats }

  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat].participant

    if (participant === null || participant.kind !== 'human') {
      continue
    }

    nextSeats[seat] = {
      ...room.seats[seat],
      participant: {
        ...participant,
        connectionId: null,
        isConnected: false,
        lastSeenAt: now,
        // Legacy snapshots (записани преди добавянето на полето) нямат
        // permanentlyLeftAt в JSON-а изобщо → след JSON.parse е `undefined`,
        // не `null`. Нормализираме тук, на единственото място, което вече
        // rehydrate-ва всеки restored human participant — иначе isProfileInActiveGame
        // би третирала undefined различно от null според само TS типа,
        // който JSON round-trip не спазва рънтайм.
        permanentlyLeftAt: participant.permanentlyLeftAt ?? null,
      },
    }
  }

  const authoritativeState = room.game.authoritativeState

  if (!isRuntimeAuthoritativeState(authoritativeState)) {
    return {
      ...room,
      updatedAt: now,
      seats: nextSeats,
      game: {
        ...room.game,
        updatedAt: now,
      },
    }
  }

  const rebasedAuthoritativeState = rebaseServerStateToEventAt(
    authoritativeState,
    now,
  )

  return {
    ...room,
    updatedAt: now,
    seats: nextSeats,
    game: {
      ...room.game,
      updatedAt: now,
      timerDeadlineAt: rebasedAuthoritativeState.timer.expiresAt,
      authoritativeState: rebasedAuthoritativeState,
    },
  }
}

function loadPersistedServerState(): ServerState {
  // Restart-safety recovery (виж production инцидента: completed турнирен
  // walkover/normal мач, чиято стая никога не получи status='finished' преди
  // restart) — премахва stale active_room_snapshots редове за вече completed
  // tournament_matches, ПРЕДИ да ги рестартираме в runtime-а. Idempotent,
  // не пипа tournament_matches/settlement/economy.
  const staleTournamentSnapshotsRemoved =
    activeRoomSnapshotStore.deactivateStaleCompletedTournamentRoomSnapshots()
  if (staleTournamentSnapshotsRemoved > 0) {
    console.log(
      `[room-snapshot] deactivated stale completed-tournament-match snapshots=${staleTournamentSnapshotsRemoved}`,
    )
  }

  const restoredRooms = activeRoomSnapshotStore.loadActiveRooms()
  const now = Date.now()
  let nextServerState = createInitialServerState()

  for (const room of restoredRooms) {
    nextServerState = upsertServerRoom(
      nextServerState,
      prepareRestoredRoomForServerStart(room, now),
    )
  }

  console.log(`[room-snapshot] restored active rooms=${restoredRooms.length}`)

  return nextServerState
}

function persistRoomSnapshot(room: ServerRoom): void {
  try {
    activeRoomSnapshotStore.upsertRoom(room)
  } catch (error) {
    console.error(`[room-snapshot] failed to persist room=${room.id}`, error)
  }
}

function markRoomSnapshotRemoved(roomId: string): void {
  try {
    activeRoomSnapshotStore.markRoomRemoved(roomId)
  } catch (error) {
    console.error(`[room-snapshot] failed to remove room=${roomId}`, error)
  }
}

function commitServerRoomReplacement(
  room: ServerRoom,
  currentServerState: ServerState = serverState,
): ServerState {
  roomRevisionRegistry.ensure(room.id)
  const nextServerState = upsertServerRoom(currentServerState, room)
  roomRevisionRegistry.bump(room.id)
  return nextServerState
}

function commitServerRoomWithSnapshot(
  room: ServerRoom,
  currentServerState: ServerState = serverState,
): ServerState {
  persistRoomSnapshot(room)
  // Единствената наистина универсална точка, през която минава всяко
  // authoritative room state advance (worker-tick batch commits И direct
  // submit_play_card/submit_bid_action/submit_cut handlers) — coordinator-ът
  // сам прави delta detection спрямо последно изпратения score, затова
  // безопасно е да се вика тук без риск от spam при всяка карта (виж
  // notifyFeederScoreProgress коментара в tournamentCoordinator.ts).
  tournamentCoordinator?.notifyFeederScoreProgress(room)
  return commitServerRoomReplacement(room, currentServerState)
}

function removeCommittedServerRoom(
  roomId: string,
  currentServerState: ServerState = serverState,
): ServerState {
  const nextRooms = { ...currentServerState.rooms }
  delete nextRooms[roomId]
  roomRevisionRegistry.remove(roomId)

  const nextState: ServerState = {
    ...currentServerState,
    rooms: nextRooms,
  }

  // Detach any surviving connections still bound to this room (напр. socket
  // оставен отворен след finished-match TTL/reconnect-grace reap) — иначе
  // connection.currentRoomId остава да сочи към вече изтрита стая, виж
  // detachConnectionsBoundToRoom.ts за пълния root-cause коментар.
  return detachConnectionsBoundToRoom(nextState, roomId)
}

let serverState: ServerState = loadPersistedServerState()
const roomRevisionRegistry = createRoomRevisionRegistry()

for (const room of Object.values(serverState.rooms)) {
  roomRevisionRegistry.ensure(room.id)
}

let matchmakingState: MatchmakingState = createInitialMatchmakingState()
let matchmakingCapacityRetryAt = 0

const socketRegistry = new Map<ConnectionId, WebSocket>()
const guestIdByConnection = new Map<ConnectionId, string>()
const roomGameRuntimeRegistry = new Map<string, ServerGameRuntime>()

const inProcessActiveRoomRuntime =
  createInProcessActiveRoomRuntime(roomGameRuntimeRegistry)

let activeRoomWorkerManager: GameWorkerManager =
  createInProcessGameWorkerManager({
    workerCount: 1,
    maxRoomsPerWorker: 1000,
  })

let roomShadowSynchronizer: RoomShadowSynchronizer | null = null

function createGameWorkerPoolManagerAdapter(
  pool: GameWorkerPool,
): GameWorkerManager {
  function getWorkers(): readonly GameWorkerSnapshot[] {
    return pool.getHealth().workers.map((worker) => ({
      workerId: worker.workerId,
      status: worker.state === 'ready' ? 'ready' : 'stopped',
      activeRooms: worker.assignedRooms,
      maxRooms: worker.maxRooms,
    }))
  }

  return {
    ensureRoom(roomId: string): string | null {
      const result = pool.ensureRoom(roomId)
      return result.ok ? result.workerId : null
    },
    getWorkerIdForRoom(roomId: string): string | null {
      return pool.getWorkerIdForRoom(roomId)
    },
    removeRoom(roomId: string): void {
      void pool.releaseRoom(roomId).catch((error: unknown) => {
        console.error('[game-worker-pool] Room release failed:', error)
      })
    },
    getWorkers,
    getHealth(): GameWorkerManagerHealth {
      const health = pool.getHealth()
      return {
        configuredWorkers: health.workerCount,
        readyWorkers: health.readyWorkers,
        totalActiveRooms: health.totalAssignedRooms,
        workers: getWorkers(),
      }
    },
  }
}

const activeRoomWorkerManagerProxy: GameWorkerManager = {
  ensureRoom(roomId: string): string | null {
    return activeRoomWorkerManager.ensureRoom(roomId)
  },
  getWorkerIdForRoom(roomId: string): string | null {
    return activeRoomWorkerManager.getWorkerIdForRoom(roomId)
  },
  removeRoom(roomId: string): void {
    activeRoomWorkerManager.removeRoom(roomId)
  },
  getWorkers(): readonly GameWorkerSnapshot[] {
    return activeRoomWorkerManager.getWorkers()
  },
  getHealth(): GameWorkerManagerHealth {
    return activeRoomWorkerManager.getHealth()
  },
}

const roomShadowNotificationTarget = {
  desireRoom(roomId: string): void {
    roomShadowSynchronizer?.desireRoom(roomId)
  },
  forgetRoom(roomId: string): void {
    roomShadowSynchronizer?.forgetRoom(roomId)
  },
}

const activeRoomRuntime =
  createWorkerBackedActiveRoomRuntime({
    workerManager: activeRoomWorkerManagerProxy,
    delegate: inProcessActiveRoomRuntime,
    roomShadowSynchronizer: roomShadowNotificationTarget,
  })

function buildPrivateRoomSnapshot(room: PrivateRoom): PrivateRoomSnapshot {
  return {
    id: room.id,
    kind: room.kind,
    stake: room.stake,
    slots: room.slots.map((slot) => ({
      team: slot.team,
      slotIndex: slot.slotIndex,
      occupant:
        slot.occupant === null
          ? null
          : slot.occupant.kind === 'human'
            ? {
                profileId: slot.occupant.profileId,
                displayName: slot.occupant.displayName,
                avatarUrl: slot.occupant.avatarUrl,
                level: slot.occupant.level,
                rankTitle: slot.occupant.rankTitle,
                isHost: slot.occupant.connectionId === room.hostConnectionId,
                isBot: false,
              }
            : {
                profileId: slot.occupant.botProfileId ?? null,
                displayName: slot.occupant.identity.displayName,
                avatarUrl: slot.occupant.identity.avatarUrl,
                level: slot.occupant.identity.level,
                rankTitle: slot.occupant.identity.rankTitle,
                isHost: false,
                isBot: true,
              },
    })),
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    manualStart: room.manualStart,
    canManualStart: room.manualStart && room.slots.every((s) => s.occupant !== null),
  }
}

function broadcastPrivateRoomsListToLobbyConnections(): void {
  const snapshots = privateRoomsStore.listRooms().map(buildPrivateRoomSnapshot)

  for (const conn of Object.values(serverState.connections)) {
    if (conn.status !== 'connected' || conn.currentRoomId !== null) {
      continue
    }
    safeSendToConnection(conn.id, { type: 'private_rooms_list', rooms: snapshots })
  }
}

// ─── "Играещи"/"Приключили" lobby listing (виж privateRoomMatchStore.ts) ───
// Тесен, lobby-safe DTO — НИКОГА hands/deck/bidding internals/trick state.

const PRIVATE_ROOM_FINISHED_VISIBILITY_HOURS = 2

function buildPrivateRoomMatchOccupant(occupant: {
  profileId: string | null
  displayName: string
  avatarUrl: string | null
  isBot: boolean
}): PrivateRoomMatchOccupant {
  return {
    profileId: occupant.profileId,
    displayName: occupant.displayName,
    avatarUrl: occupant.avatarUrl,
    isBot: occupant.isBot,
  }
}

// Извиква се СЛЕД commitServerRoomWithSnapshot в handlePrivateRoomReady, т.е.
// точно в момента, в който waiting private room-ът е потвърдено станал жива
// игра — privateRoom.slots все още носи оригиналния team/bot occupant състав
// (ServerRoom seats носят различна, по-широка форма, затова четем от
// privateRoom, не от initializedRoom).
function recordPrivateRoomMatchStarted(privateRoom: PrivateRoom, roomId: string): void {
  const teamASlots = getTeamSlots(privateRoom, 'A')
  const teamBSlots = getTeamSlots(privateRoom, 'B')

  function toOccupant(slot: PrivateRoomSlot): PrivateRoomMatchOccupant {
    const occupant = slot.occupant
    if (occupant === null) {
      // Не би трябвало да е възможно тук (readiness gate изисква 4/4 заети
      // слотове преди onRoomReady), но пазим safe fallback вместо throw.
      return { profileId: null, displayName: '—', avatarUrl: null, isBot: false }
    }
    return occupant.kind === 'human'
      ? buildPrivateRoomMatchOccupant({
          profileId: occupant.profileId,
          displayName: occupant.displayName,
          avatarUrl: occupant.avatarUrl,
          isBot: false,
        })
      : buildPrivateRoomMatchOccupant({
          profileId: occupant.botProfileId ?? null,
          displayName: occupant.identity.displayName,
          avatarUrl: occupant.identity.avatarUrl,
          isBot: true,
        })
  }

  privateRoomMatchStore.recordMatchStarted({
    roomId,
    privateRoomId: privateRoom.id,
    stake: privateRoom.stake,
    teamA: [toOccupant(teamASlots[0]), toOccupant(teamASlots[1])],
    teamB: [toOccupant(teamBSlots[0]), toOccupant(teamBSlots[1])],
  })
}

function privateRoomMatchRecordToSnapshot(record: PrivateRoomMatchRecord): PrivateRoomMatchSnapshot {
  return {
    roomId: record.roomId,
    status: record.status,
    stake: record.stake,
    teamA: record.teamA,
    teamB: record.teamB,
    teamAScore: record.teamAScore ?? 0,
    teamBScore: record.teamBScore ?? 0,
    startedAt: Date.parse(dbDateToUtc(record.startedAt)),
    finishedAt: record.finishedAt !== null ? Date.parse(dbDateToUtc(record.finishedAt)) : null,
  }
}

function buildPrivateGamesListMessage(): PrivateGamesListMessage {
  return {
    type: 'private_games_list',
    playing: privateRoomMatchStore.listPlayingMatches().map(privateRoomMatchRecordToSnapshot),
    finished: privateRoomMatchStore
      .listFinishedMatches(PRIVATE_ROOM_FINISHED_VISIBILITY_HOURS)
      .map(privateRoomMatchRecordToSnapshot),
  }
}

// Mirror на broadcastPrivateRoomsListToLobbyConnections — само connections
// извън активна игра (currentRoomId === null) виждат lobby listing-а.
function broadcastPrivateGamesListToLobbyConnections(): void {
  const message = buildPrivateGamesListMessage()

  for (const conn of Object.values(serverState.connections)) {
    if (conn.status !== 'connected' || conn.currentRoomId !== null) {
      continue
    }
    safeSendToConnection(conn.id, message)
  }
}

// Targeted score-only push (виж §7 брифа — без пълен playing/finished списък
// при всяка score промяна). Dedup чрез signature Map — mirror на established
// tournamentCoordinator.notifyFeederScoreProgress lastNotifiedFeederScoreByMatchId
// pattern-а, за да не спами SQL UPDATE + WS broadcast при всеки game tick,
// само при реална score промяна.
const lastNotifiedPrivateGameScoreByRoomId = new Map<string, string>()

function notifyPrivateGameScoreProgress(room: ServerRoom): void {
  if (room.config.isPrivateTableOrigin !== true) return
  const authState = room.game.authoritativeState
  if (authState === null || 'kind' in authState) return
  if (authState.matchEnded !== null) return

  const teamAScore = authState.score.match.teamA
  const teamBScore = authState.score.match.teamB
  const signature = `${teamAScore}:${teamBScore}`
  if (lastNotifiedPrivateGameScoreByRoomId.get(room.id) === signature) return
  lastNotifiedPrivateGameScoreByRoomId.set(room.id, signature)

  privateRoomMatchStore.recordMatchScoreUpdate(room.id, teamAScore, teamBScore)

  const message: PrivateGameScoreUpdatedMessage = {
    type: 'private_game_score_updated',
    roomId: room.id,
    teamAScore,
    teamBScore,
  }
  for (const conn of Object.values(serverState.connections)) {
    if (conn.status !== 'connected' || conn.currentRoomId !== null) {
      continue
    }
    safeSendToConnection(conn.id, message)
  }
}

// Извиква се точно веднъж, при match-ended прехода (същия
// shouldRunMatchCompletionSideEffects idempotency guard като recordCompletedMatch/
// payoutMatchWinners по-долу) — записва final score, маха room-а от
// "Играещи" push dedup Map-а (memory cleanup, стаята никога повече няма да
// tick-не score update), и известява lobby-то с обновения playing/finished
// списък (targeted refresh, не всеки tick).
function recordPrivateGameFinishedIfApplicable(room: ServerRoom): void {
  if (room.config.isPrivateTableOrigin !== true) return
  const authState = room.game.authoritativeState
  const teamAScore = authState !== null && !('kind' in authState) ? authState.score.match.teamA : 0
  const teamBScore = authState !== null && !('kind' in authState) ? authState.score.match.teamB : 0

  lastNotifiedPrivateGameScoreByRoomId.delete(room.id)
  privateRoomMatchStore.recordMatchFinished(room.id, teamAScore, teamBScore)
  broadcastPrivateGamesListToLobbyConnections()
}

type PrivateRoomStakeEligibilityResult =
  | { ok: true }
  | {
      ok: false
      code: 'private_room_stake_unavailable' | 'private_room_insufficient_balance' | 'private_room_level_required'
      message: string
    }

// Преизползва същите проверки като join_matchmaking (stake config
// активна/съществуваща, минимално ниво, достатъчен баланс), за да не се
// стигне до "счупена" частна маса, която никога не може да потегли.
function checkPrivateRoomStakeEligibility(
  profileId: string,
  playerLevel: number | null,
  stake: number,
): PrivateRoomStakeEligibilityResult {
  const room = matchRoomsStore.getRoom(stake)
  if (!room || !room.isEnabled) {
    return {
      ok: false,
      code: 'private_room_stake_unavailable',
      message: 'Този залог вече не е наличен. Изберете друг залог.',
    }
  }

  const currentLevel = playerLevel ?? 1
  if (currentLevel < room.minLevel) {
    return {
      ok: false,
      code: 'private_room_level_required',
      message: `За залог ${room.stakeAmount} се изисква ниво ${room.minLevel}. Вашето ниво е ${currentLevel}.`,
    }
  }

  if (!matchEconomyStore.hasEnoughBalance(profileId, stake)) {
    return {
      ok: false,
      code: 'private_room_insufficient_balance',
      message: `Недостатъчен баланс за маса със залог ${room.stakeAmount} жълтици.`,
    }
  }

  return { ok: true }
}

function broadcastPrivateRoomCreatedNotice(input: {
  creatorProfileId: string
  creatorDisplayName: string
  creatorAvatarUrl: string | null
  roomId: string
}): void {
  for (const conn of Object.values(serverState.connections)) {
    if (conn.status !== 'connected' || conn.profileId === null || conn.profileId === input.creatorProfileId) {
      continue
    }

    safeSendToConnection(conn.id, {
      type: 'private_room_created_notice',
      notificationId: input.roomId,
      creatorDisplayName: input.creatorDisplayName,
      creatorAvatarUrl: input.creatorAvatarUrl,
      recipientInActiveGame: isProfileInActiveGame(conn.profileId),
    })
  }
}

function sendPrivateRoomUpdateToMembers(room: PrivateRoom): void {
  const snapshot = buildPrivateRoomSnapshot(room)
  for (const slot of room.slots) {
    if (slot.occupant?.kind === 'human') {
      safeSendToConnection(slot.occupant.connectionId, { type: 'private_room_updated', room: snapshot })
    }
  }
}

// Стаята стана 4/4, но evaluateRoomReadiness я отхвърли (блокирано
// партньорство или — практически недостижимо благодарение на
// excludedProfileIds в 'add_bot_to_private_room_team' — дублирана bot
// identity). Стаята остава жива в store-а (не detach-ната), никой не се
// изритва — просто известяваме всички текущи човешки участници защо играта
// не е стартирала.
function broadcastPrivateRoomNotReadyInfo(room: PrivateRoom, readiness: RoomReadiness): void {
  if (readiness.ready) return

  if (readiness.reason === 'duplicate_bot_identity') {
    console.error(`[private-room] duplicate bot identity detected room=${room.id} — should be unreachable`)
  }

  const message =
    readiness.reason === 'blocked_partnership'
      ? `Играта не може да започне — двама играчи в Отбор ${readiness.blockedTeam === 'A' ? 'А' : 'Б'} не могат да бъдат партньори.`
      : 'Възникна проблем при стартирането на масата. Опитайте отново.'

  for (const slot of room.slots) {
    if (slot.occupant?.kind === 'human') {
      safeSendToConnection(slot.occupant.connectionId, { type: 'error', message })
    }
  }
}

// PrivateRoomHumanOccupant.connectionId е снапшот, взет в момента на
// join/create и може вече да е мъртъв (WS reconnect на мобилна мрежа създава
// нов connection.id, но старият остава в room.slots до следващия
// reconnectMember() — виж коментара в privateRoomsStore.ts). Затова тук
// НИКОГА не подаваме occupant.connectionId directно на createHumanParticipant/
// attachConnectionToRoomSeat — първо намираме реално жива връзка:
//  1) ако occupant.connectionId все още е 'connected' И socket-ът е OPEN,
//     ползваме нея непроменена;
//  2) иначе търсим друга 'connected' + OPEN връзка със същия profileId
//     (потребителят вече се е reconnect-нал с нов connection.id, но
//     privateRoomsStore все още не е получил reconnectMember() за него —
//     най-лошият момент от race-а: масата станала 4/4 точно докато той
//     reconnect-ва);
//  3) иначе няма жива връзка — връщаме null, участникът остава isConnected:
//     false в новата стая и се поема от съществуващия bot-takeover механизъм,
//     вместо мъртъв connectionId да бъде третиран като "connected".
function resolveLiveConnectionForMember(
  state: ServerState,
  occupant: PrivateRoomHumanOccupant,
): ConnectionId | null {
  const storedConn = getConnectionById(state, occupant.connectionId)
  const storedSocket = socketRegistry.get(occupant.connectionId)
  if (storedConn?.status === 'connected' && storedSocket?.readyState === WebSocket.OPEN) {
    return occupant.connectionId
  }

  if (occupant.profileId === null) {
    return null
  }

  for (const candidate of Object.values(state.connections)) {
    if (candidate.profileId !== occupant.profileId || candidate.status !== 'connected') {
      continue
    }
    const candidateSocket = socketRegistry.get(candidate.id)
    if (candidateSocket?.readyState === WebSocket.OPEN) {
      return candidate.id
    }
  }

  return null
}

// Заменя старите handlePrivateRoomFull/handlePrivateRoomBotFill — с новия
// team/slot модел occupant-ите (human ИЛИ bot) вече са напълно резолвнати в
// privateRoom.slots в момента на извикване (joinTeam/addBotToTeam вече са
// направили readiness проверката), затова няма нужда от отделен bot-fill
// код-път нито от random shuffle — mapPrivateRoomSlotToSeat() е чиста
// детерминирана функция, извиква се по фиксирания A0,A1,B0,B1 ред.
function handlePrivateRoomReady(privateRoom: PrivateRoom): void {
  const hasBotOccupant = privateRoom.slots.some((s) => s.occupant?.kind === 'bot')

  let currentRoom = createServerRoom({
    config: {
      allowBots: hasBotOccupant,
      isPrivate: true,
      isPrivateTableOrigin: true,
      stakeAmount: privateRoom.stake,
    },
  })
  let nextServerState = upsertServerRoom(serverState, currentRoom)

  const seatAssignments: Array<{ connectionId: string; seat: Seat }> = []
  const liveConnectionIdsForExpiryNotice: string[] = []

  for (const slot of privateRoom.slots) {
    const occupant = slot.occupant
    if (occupant === null) continue
    const seat = mapPrivateRoomSlotToSeat(slot.team, slot.slotIndex)

    if (occupant.kind === 'human') {
      const publicProfile = occupant.profileId
        ? playerProgressStore.getPublicProfile(occupant.profileId)
        : null

      const liveConnectionId = resolveLiveConnectionForMember(nextServerState, occupant)
      if (liveConnectionId !== null) {
        liveConnectionIdsForExpiryNotice.push(liveConnectionId)
      }

      const participant = createHumanParticipant({
        connectionId: liveConnectionId,
        identity: {
          profileId: occupant.profileId,
          displayName: occupant.displayName,
          avatarUrl: occupant.avatarUrl,
          level: occupant.level,
          rankTitle: occupant.rankTitle,
        },
        publicProfile,
      })

      currentRoom = seatParticipantInRoom(currentRoom, seat, participant)
      nextServerState = updateServerRoomInState(nextServerState, currentRoom.id, currentRoom)

      if (liveConnectionId !== null) {
        const memberConn = getConnectionById(nextServerState, liveConnectionId)
        if (memberConn) {
          const nextMemberConn = attachConnectionToRoomSeat(memberConn, liveConnectionId, currentRoom, seat)
          nextServerState = updateServerConnectionInState(nextServerState, liveConnectionId, nextMemberConn)
          seatAssignments.push({ connectionId: liveConnectionId, seat })
        }
      }
    } else {
      const botParticipant = createBotParticipant({
        botProfileId: occupant.botProfileId,
        botCode: occupant.botCode,
        difficulty: occupant.difficulty,
        behaviorPreset: occupant.behaviorPreset,
        logicSource: occupant.logicSource,
        identity: occupant.identity,
      })
      currentRoom = seatParticipantInRoom(currentRoom, seat, botParticipant)
      nextServerState = updateServerRoomInState(nextServerState, currentRoom.id, currentRoom)
    }
  }

  currentRoom = updateRoomHostPlayerId(currentRoom)
  nextServerState = updateServerRoomInState(nextServerState, currentRoom.id, currentRoom)

  const initializedRoom = initializeRoomAuthoritativeGameState(currentRoom)

  function notifyMembersExpired(): void {
    // Известява живите (resolved) връзки — не суровите privateRoom.slots
    // occupant-и, които може вече да сочат към мъртъв connectionId (виж
    // resolveLiveConnectionForMember по-горе).
    for (const connectionId of liveConnectionIdsForExpiryNotice) {
      safeSendToConnection(connectionId, {
        type: 'private_room_expired',
        privateRoomId: privateRoom.id,
      })
    }
  }

  const ensureResult = activeRoomRuntime.ensureRoom(initializedRoom)
  if (!ensureResult.ok) {
    console.error(
      `[private-room] no runtime capacity for room=${initializedRoom.id}: ${ensureResult.reason}`,
    )
    notifyMembersExpired()
    privateRoomChatStore.clearRoom(privateRoom.id)
    return
  }

  if (privateRoom.stake > 0) {
    const stakeResult = matchEconomyStore.collectRoomStakes(initializedRoom, privateRoom.stake)
    if (!stakeResult.ok) {
      console.error(`[private-room] stake collection failed room=${initializedRoom.id}: ${stakeResult.message}`)
      activeRoomRuntime.removeRoom(initializedRoom.id)
      notifyMembersExpired()
      privateRoomChatStore.clearRoom(privateRoom.id)
      return
    }

    if (hasBotOccupant) {
      const botStakeResult = matchEconomyStore.collectBotStakes(initializedRoom, privateRoom.stake)
      if (!botStakeResult.ok) {
        console.error(`[private-room] bot-stake collection failed room=${initializedRoom.id}: ${botStakeResult.message}`)
      }
    }
  }

  nextServerState = commitServerRoomWithSnapshot(initializedRoom, nextServerState)
  serverState = nextServerState

  recordPrivateRoomMatchStarted(privateRoom, initializedRoom.id)
  broadcastPrivateGamesListToLobbyConnections()

  for (const { connectionId, seat } of seatAssignments) {
    safeSendToConnection(connectionId, {
      type: 'private_room_full',
      roomId: initializedRoom.id,
      seat,
      stake: privateRoom.stake,
    })
  }

  broadcastRoomSnapshots(initializedRoom, socketRegistry)
  privateRoomChatStore.clearRoom(privateRoom.id)

  // Late-arriving отговори на покани за тази вече стартирала стая биха се
  // провалили тихо (стаята вече не е в rooms map-а) — проактивно ги отменяме,
  // за да получи поканеният ясен "невалидна вече" сигнал.
  for (const invite of privateRoom.pendingInvites) {
    cancelPrivateRoomInviteTimer(invite.inviteId)
    const inviteeConn = Object.values(serverState.connections).find(
      (c) => c.profileId === invite.toProfileId && c.status === 'connected',
    )
    if (inviteeConn) {
      safeSendToConnection(inviteeConn.id, {
        type: 'private_room_invite_cancelled',
        inviteId: invite.inviteId,
      })
    }
  }
}

function handlePrivateRoomExpired(room: PrivateRoom): void {
  privateRoomChatStore.clearRoom(room.id)
  for (const invite of room.pendingInvites) {
    cancelPrivateRoomInviteTimer(invite.inviteId)
    const inviteeConn = Object.values(serverState.connections).find(
      (c) => c.profileId === invite.toProfileId && c.status === 'connected',
    )
    if (inviteeConn) {
      safeSendToConnection(inviteeConn.id, {
        type: 'private_room_invite_cancelled',
        inviteId: invite.inviteId,
      })
    }
  }
  for (const slot of room.slots) {
    if (slot.occupant?.kind === 'human') {
      safeSendToConnection(slot.occupant.connectionId, {
        type: 'private_room_expired',
        privateRoomId: room.id,
      })
    }
  }
}

const privateRoomInviteTimers = new Map<string, ReturnType<typeof setTimeout>>()

function cancelPrivateRoomInviteTimer(inviteId: string): void {
  const timer = privateRoomInviteTimers.get(inviteId)
  if (timer !== undefined) {
    clearTimeout(timer)
    privateRoomInviteTimers.delete(inviteId)
  }
}

function clearPrivateRoomInviteTimers(): void {
  for (const timer of privateRoomInviteTimers.values()) {
    clearTimeout(timer)
  }

  privateRoomInviteTimers.clear()
}

function schedulePrivateRoomInviteExpiry(
  inviteId: string,
  toProfileId: string,
  expiresAt: number,
): void {
  const delay = Math.max(0, expiresAt - Date.now())
  const timer = setTimeout(() => {
    privateRoomInviteTimers.delete(inviteId)

    if (isServerShuttingDown) {
      return
    }

    privateRoomsStore.removeInviteById(inviteId)
    const targetConn = Object.values(serverState.connections).find(
      (c) => c.profileId === toProfileId && c.status === 'connected',
    )
    if (targetConn) {
      safeSendToConnection(targetConn.id, { type: 'private_room_invite_expired', inviteId })
    }
  }, delay)
  privateRoomInviteTimers.set(inviteId, timer)
}

function handlePrivateRoomClosed(room: PrivateRoom): void {
  privateRoomChatStore.clearRoom(room.id)
  for (const invite of room.pendingInvites) {
    cancelPrivateRoomInviteTimer(invite.inviteId)
    const inviteeConn = Object.values(serverState.connections).find(
      (c) => c.profileId === invite.toProfileId && c.status === 'connected',
    )
    if (inviteeConn) {
      safeSendToConnection(inviteeConn.id, {
        type: 'private_room_invite_cancelled',
        inviteId: invite.inviteId,
      })
    }
  }
  for (const slot of room.slots) {
    if (slot.occupant?.kind === 'human' && slot.occupant.connectionId !== room.hostConnectionId) {
      safeSendToConnection(slot.occupant.connectionId, {
        type: 'private_room_closed',
        privateRoomId: room.id,
      })
    }
  }
}

function handlePrivateRoomMemberLeft(room: PrivateRoom, occupant: PrivateRoomHumanOccupant): void {
  safeSendToConnection(room.hostConnectionId, {
    type: 'private_room_member_left',
    displayName: occupant.displayName,
  })
}

// Targeted съобщение само към изритания играч — оставащите members (вкл.
// host-а, който сам инициира kick-а) получават актуалния snapshot чрез
// sendPrivateRoomUpdateToMembers, извикан от самия kick_from_private_room
// handler-а (mirror на handlePrivateRoomClosed, който също explicit
// изключва host-а от получателите на targeted нотификацията).
function handlePrivateRoomMemberKicked(room: PrivateRoom, occupant: PrivateRoomHumanOccupant): void {
  safeSendToConnection(occupant.connectionId, {
    type: 'private_room_kicked',
    privateRoomId: room.id,
  })
}

const privateRoomChatStore = createPrivateRoomChatStore()

const privateRoomsStore = createPrivateRoomsStore({
  onRoomsChanged: () => broadcastPrivateRoomsListToLobbyConnections(),
  onRoomReady: (room) => handlePrivateRoomReady(room),
  onRoomExpired: (room) => handlePrivateRoomExpired(room),
  onRoomClosed: (room) => handlePrivateRoomClosed(room),
  onMemberLeft: (room, occupant) => handlePrivateRoomMemberLeft(room, occupant),
  onMemberKicked: (room, occupant) => handlePrivateRoomMemberKicked(room, occupant),
})

for (const room of Object.values(serverState.rooms)) {
  const ensureResult = activeRoomRuntime.ensureRoom(room)

  if (!ensureResult.ok) {
    throw new Error(
      `[startup] Unable to restore active room=${room.id}: ${ensureResult.reason}`,
    )
  }

  persistRoomSnapshot(room)
}

function getSocketByConnectionId(connectionId: ConnectionId): WebSocket | null {
  return socketRegistry.get(connectionId) ?? null
}

function safeSendToConnection(connectionId: ConnectionId, payload: unknown): void {
  const socket = getSocketByConnectionId(connectionId)

  if (socket === null || socket.readyState !== WebSocket.OPEN) {
    return
  }

  sendJsonMessage(socket, payload)
}

function sendToOpenProfileConnections(profileId: string, payload: unknown): number {
  let sentCount = 0

  for (const connection of Object.values(serverState.connections)) {
    if (connection.profileId !== profileId || connection.status !== 'connected') {
      continue
    }

    const socket = getSocketByConnectionId(connection.id)
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      continue
    }

    sendJsonMessage(socket, payload)
    sentCount += 1
  }

  return sentCount
}

function isTournamentMatchRoom(room: ServerRoom): boolean {
  return room.config.isTournamentMatchOrigin === true && !!room.config.tournamentMatchId
}

function sendTournamentMatchAssignment(
  profileId: string,
  assignment: TournamentMatchAssignment,
): void {
  sendToOpenProfileConnections(profileId, {
    type: 'tournament_match_assigned',
    assignment,
  })
}

// Server-authoritative refund push (§4/§5 в task spec-а) — само след реално
// committed refund (per-profile сумите идват directly от economy store
// резултата, никога преизчислени тук). Изпраща се само до online
// connections за всеки реално refund-нат профил; офлайн профили не получават
// нищо ретроактивно. eventId е уникален per push (client-side dedup).
function sendTournamentEconomyRefundNotices(
  tournamentId: string,
  reason: 'creator_cancelled' | 'fill_expired' | 'scheduled_underfilled' | 'partner_left',
  refundedProfiles: Array<{ profileId: string; amount: number }>,
): void {
  const occurredAt = new Date().toISOString()
  for (const { profileId, amount } of refundedProfiles) {
    sendToOpenProfileConnections(profileId, {
      type: 'tournament_economy_notice',
      eventId: randomUUID(),
      tournamentId,
      reason,
      amount,
      occurredAt,
    })
  }
}

function cleanupTempBotsFromRoom(room: ServerRoom): void {
  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat].participant
    if (participant?.kind !== 'bot') continue
    const profileId = participant.botProfileId ?? null
    if (profileId && profileId.startsWith('temp-bot-')) {
      playerProgressStore.deleteTemporaryBotProfile(profileId)
    }
  }
}

function cleanupInactiveRoomIfNeeded(roomId: string, now: number = Date.now()): boolean {
  const room = serverState.rooms[roomId] ?? null

  if (room === null) {
    markRoomSnapshotRemoved(roomId)
    activeRoomRuntime.removeRoom(roomId)
    roomRevisionRegistry.remove(roomId)
    return true
  }

  if (shouldKeepRoomAlive(room, now)) {
    return false
  }

  serverState = removeCommittedServerRoom(roomId)

  cleanupTempBotsFromRoom(room)
  markRoomSnapshotRemoved(roomId)
  activeRoomRuntime.removeRoom(roomId)
  console.log(`[room-cleanup] removed inactive room=${roomId}`)

  return true
}

// За разлика от cleanupInactiveRoomIfNeeded, тук НЕ минаваме през
// shouldKeepRoomAlive (за турнирна стая тя винаги връща true, докато
// status !== 'finished' — виж serverGameRuntimeHelpers.ts) — ползва се
// единствено от local-tournament-test "Нулирай теста" (§12 в task spec-а),
// където трябва форсирано да затворим турнирна стая независимо от фазата ѝ.
// Огледално на closeCompletedRoom callback-а, подаден на
// createTournamentCoordinator по-долу. No-op ако стаята вече не съществува.
function forceRemoveTournamentRoomById(roomId: string): void {
  const room = serverState.rooms[roomId]
  if (room === undefined) return
  serverState = removeCommittedServerRoom(roomId)
  cleanupTempBotsFromRoom(room)
  markRoomSnapshotRemoved(roomId)
  activeRoomRuntime.removeRoom(roomId)
}

async function tickRoomGameRuntimes(): Promise<void> {
  if (isServerShuttingDown) {
    return
  }

  const trackedRoomIds = activeRoomRuntime.listTrackedRoomIds()

  if (trackedRoomIds.length === 0) {
    return
  }

  const now = Date.now()
  const roomsToTick: ServerRoom[] = []

  for (const roomId of trackedRoomIds) {
    const room = serverState.rooms[roomId] ?? null

    if (room === null) {
      activeRoomRuntime.removeRoom(roomId)
      roomRevisionRegistry.remove(roomId)
      continue
    }

    if (!shouldKeepRoomAlive(room, now)) {
      serverState = removeCommittedServerRoom(roomId)
      cleanupTempBotsFromRoom(room)
      markRoomSnapshotRemoved(roomId)
      activeRoomRuntime.removeRoom(roomId)
      console.log(`[room-cleanup] removed inactive room=${roomId}`)
      continue
    }

    roomsToTick.push(room)
  }

  if (roomsToTick.length > 0) {
    const batchResult = await gameWorkerTickOrchestrator.computeCandidates({
      now,
      rooms: roomsToTick,
    })

    if (isServerShuttingDown) {
      return
    }

    if (batchResult.status === 'busy') {
      return
    }

    if (batchResult.status === 'failed') {
      logGameWorkerTickFailure(`Candidate batch failed: ${batchResult.message}`)
      return
    }

    for (const tickResult of batchResult.results) {
      if (tickResult.kind === 'unchanged' || tickResult.kind === 'stale') {
        continue
      }

      if (tickResult.kind === 'not_assigned') {
        continue
      }

      if (tickResult.kind === 'compute_failed') {
        logGameWorkerTickFailure(
          `Candidate compute failed room=${tickResult.roomId}: ${tickResult.message}`,
        )
        continue
      }

      const nextRoom = tickResult.room
      const roomId = tickResult.roomId

      const currentRoom = serverState.rooms[roomId] ?? null
      if (currentRoom === null) {
        continue
      }

      const applyResult = applyAcceptedGameWorkerCandidate({
        serverState,
        roomId,
        baseRevision: tickResult.baseRevision,
        candidate: nextRoom,
        revisionRegistry: roomRevisionRegistry,
        commitCanonicalRoom: (room) => {
          serverState = upsertServerRoom(serverState, room)
        },
        persist: (room) => {
          activeRoomSnapshotStore.upsertRoom(room)
        },
        broadcast: (room) => {
          broadcastRoomSnapshots(room, socketRegistry)
        },
        onApplied: (previousRoom, room) => {
          handleTrainingRecorderOnApplied(trainingRecorder, previousRoom, room)
          logAcceptedCardPlayAudit({
            previousRoom,
            nextRoom: room,
            isHumanManualSubmission: false,
            connectionId: null,
          })
          // Worker-tick batch commits минават покрай commitServerRoomWithSnapshot
          // (виж commitCanonicalRoom по-горе — директен upsertServerRoom), затова
          // feeder score push-ът трябва да се закачи и тук отделно, за да
          // покрие bot auto-play/timer-expiry advances, не само direct
          // submit_play_card handler-и.
          tournamentCoordinator?.notifyFeederScoreProgress(room)
          notifyPrivateGameScoreProgress(room)

          const roundCapot = getRoundCapotTransition(previousRoom, room)
          if (roundCapot !== null) {
            runMatchCompletionSideEffect(
              'record-round-capot',
              room.id,
              () => {
                missionStore.recordRoundCapot({
                  room,
                  capotTeam: roundCapot.capotTeam,
                  roundKey: roundCapot.roundKey,
                })
              },
            )
          }

          const roundContra = getRoundContraTransition(previousRoom, room)
          if (roundContra !== null) {
            runMatchCompletionSideEffect(
              'record-round-contra',
              room.id,
              () => {
                missionStore.recordRoundContra({
                  room,
                  winnerTeam: roundContra.winnerTeam,
                  roundKey: roundContra.roundKey,
                })
              },
            )
          }

          if (!shouldRunMatchCompletionSideEffects(previousRoom, room)) {
            return
          }

          runMatchCompletionSideEffect(
            'record-completed-match',
            room.id,
            () => {
              playerProgressStore.recordCompletedMatch(room)
            },
          )
          runMatchCompletionSideEffect(
            'record-match-completion',
            room.id,
            () => {
              missionStore.recordMatchCompletion(room)
            },
          )
          if (isTournamentMatchRoom(room)) {
            runMatchCompletionSideEffect(
              'record-tournament-match-completion',
              room.id,
              () => {
                tournamentCoordinator?.onTournamentRoomCompleted(room)
              },
            )
          }
          runMatchCompletionSideEffect(
            'record-private-game-finished',
            room.id,
            () => {
              recordPrivateGameFinishedIfApplicable(room)
            },
          )
          const hadAwardedPrizeBeforePayout = room.awardedPrizePerSeat !== undefined
          if (!room.config.isGuestTrial && !isTournamentMatchRoom(room)) {
            runMatchCompletionSideEffect(
              'payout-match-winners',
              room.id,
              () => {
                const payoutResult = matchEconomyStore.payoutMatchWinners(room)

                if (!payoutResult.ok) {
                  console.error(
                    `[match-economy] payout failed room=${room.id}: ${payoutResult.message}`,
                  )
                } else {
                  room.awardedPrizePerSeat = payoutResult.awardedPerSeat
                }
              },
            )
          }
          // The first broadcast happened before payout completed (awardedPrizePerSeat was
          // undefined). If payout has now populated the field, send one targeted rebroadcast
          // so clients receive the correct awardedPrizeAmount. The idempotency guard on
          // shouldRunMatchCompletionSideEffects ensures this path runs only once per match.
          if (
            !hadAwardedPrizeBeforePayout &&
            room.awardedPrizePerSeat !== undefined &&
            Object.keys(room.awardedPrizePerSeat).length > 0
          ) {
            broadcastRoomSnapshots(room, socketRegistry)
          }
          if (!room.config.isGuestTrial && !isTournamentMatchRoom(room)) {
            runMatchCompletionSideEffect(
              'top-up-depleted-bot-wallets',
              room.id,
              () => {
                matchEconomyStore.topUpDepletedBotWallets(room)
              },
            )
          }
        },
      })

      if (applyResult.kind === 'persist_failed') {
        console.error(
          `[game-worker-tick] Failed to persist candidate roomId=${roomId}: ${formatErrorMessage(applyResult.error)}`,
        )
        continue
      }

      if (applyResult.kind === 'invalid') {
        console.error(`[game-worker-tick] ${applyResult.message}`)
        continue
      }

      if (applyResult.kind !== 'applied') {
        continue
      }

    }
  }
}

function tryResumeRoomForConnection(
  connectionId: ConnectionId,
  roomId: string,
  reconnectToken: string,
): ResumeRoomResult {
  const connection = getConnectionById(serverState, connectionId)

  if (connection === null) {
    return {
      ok: false,
      message: 'Connection was not found.',
    }
  }

  if (connection.currentRoomId !== null) {
    if (connection.currentRoomId === roomId) {
      const room = serverState.rooms[roomId] ?? null
      const match = room ? findHumanParticipantByReconnectToken(room, reconnectToken) : null
      if (match !== null) {
        return { ok: true, room, seat: match.seat }
      }
    }
    return {
      ok: false,
      message: `Connection "${connection.id}" is already attached to room "${connection.currentRoomId}".`,
    }
  }

  const room = serverState.rooms[roomId] ?? null

  if (room === null) {
    return {
      ok: false,
      message: 'Играта вече не е налична.',
    }
  }

  const match = findHumanParticipantByReconnectToken(room, reconnectToken)

  if (match === null) {
    if (isTournamentMatchRoom(room) && connection.profileId !== null && tournamentCoordinator !== null) {
      const takeoverResult = tournamentCoordinator.tryTakeoverNoShowBot({
        room,
        profileId: connection.profileId,
        connectionId,
        reconnectToken,
      })
      if (takeoverResult.ok) {
        const attachedConnection = attachConnectionToRoomSeat(
          connection,
          connectionId,
          takeoverResult.room,
          takeoverResult.seat,
        )
        serverState = updateServerConnectionInState(
          serverState,
          connectionId,
          attachedConnection,
        )
        activeRoomRuntime.ensureRoom(takeoverResult.room)
        return {
          ok: true,
          room: takeoverResult.room,
          seat: takeoverResult.seat,
        }
      }
      if (takeoverResult.reason === 'match_completed') {
        return {
          ok: false,
          message: 'Мачът вече е приключил.',
        }
      }
    }
    return {
      ok: false,
      message: 'Невалиден код за връщане в играта.',
    }
  }

  if (
    match.participant.isConnected &&
    match.participant.connectionId !== null &&
    match.participant.connectionId !== connectionId
  ) {
    return {
      ok: false,
      message: 'Играчът вече е свързан към тази игра.',
    }
  }

  const reconnectedParticipant = createReconnectedHumanParticipant(
    match.participant,
    connectionId,
  )

  const nextRoom = updateHumanParticipantInRoom(
    room,
    match.seat,
    reconnectedParticipant,
  )

  serverState = commitServerRoomWithSnapshot(nextRoom)

  const attachedConnection = attachConnectionToRoomSeat(
    connection,
    connectionId,
    nextRoom,
    match.seat,
  )

  serverState = updateServerConnectionInState(
    serverState,
    connectionId,
    attachedConnection,
  )

  activeRoomRuntime.ensureRoom(nextRoom)

  return {
    ok: true,
    room: nextRoom,
    seat: match.seat,
  }
}

function createFallbackPublicProfileSnapshot(
  participant: RoomParticipant,
): PlayerPublicProfileSnapshot {
  const identity = participant.identity

  return {
    profileId: identity.profileId,
    displayName: identity.displayName?.trim() || 'Играч',
    avatarUrl: identity.avatarUrl,
    level: identity.level,
    rankTitle: identity.rankTitle,
    skillRating: identity.skillRating,
    completedGamesCount: null,
    wonGamesCount: null,
    currentRankGames: null,
    nextRankGames: null,
    gamesUntilNextRank: null,
    rankProgressRatio: null,
    averageRating: null,
    totalRatingsCount: null,
    yellowCoinsBalance: null,
    gender: identity.gender ?? null,
    galleryImages: [],
    likesCount: null,
    hasLikedByMe: null,
    isBlockedByMe: null,
    isVip: null,
    vipActiveUntil: null,
  }
}

function sendPlayerProfileToConnection(
  connectionId: ConnectionId,
  roomId: string,
  seat: Seat,
): void {
  const connection = getConnectionById(serverState, connectionId)

  if (connection === null) {
    safeSendToConnection(connectionId, {
      type: 'error',
      message: 'Connection was not found.',
    })
    return
  }

  if (connection.currentRoomId !== roomId) {
    safeSendToConnection(connectionId, {
      type: 'error',
      message: 'You are not attached to this room.',
    })
    return
  }

  const room = serverState.rooms[roomId] ?? null

  if (room === null) {
    safeSendToConnection(connectionId, {
      type: 'error',
      message: `Room "${roomId}" was not found.`,
    })
    return
  }

  const participant = room.seats[seat]?.participant ?? null
  const profileId = participant?.identity.profileId ?? participant?.publicProfile?.profileId ?? null
  const dbProfile =
    profileId !== null
      ? playerProgressStore.getPublicProfile(profileId)
      : null

  const viewerProfileId = serverState.connections[connectionId]?.profileId ?? null
  const baseProfile = participant === null
    ? null
    : dbProfile ?? participant.publicProfile ?? createFallbackPublicProfileSnapshot(participant)

  const accessDenial = getProfileAccessDenial(viewerProfileId, profileId)

  if (accessDenial !== null) {
    safeSendToConnection(connectionId, {
      type: 'player_profile',
      roomId,
      seat,
      profile: null,
      ...accessDenial,
    })
    return
  }

  const enrichedProfile = baseProfile && profileId
    ? {
        ...baseProfile,
        likesCount: likeStore.getLikesCount(profileId),
        hasLikedByMe: viewerProfileId ? likeStore.hasLikedRecently(viewerProfileId, profileId) : null,
        isBlockedByMe: viewerProfileId ? blockStore.isBlocked(viewerProfileId, profileId) : null,
        isVip: vipStore.getStatus(profileId).isActive,
      }
    : baseProfile

  safeSendToConnection(connectionId, {
    type: 'player_profile',
    roomId,
    seat,
    profile: enrichedProfile,
  })
}

function isProfileInActiveGame(profileId: string): boolean {
  for (const room of Object.values(serverState.rooms)) {
    if (room.status !== 'playing') {
      continue
    }

    for (const seat of SERVER_SEAT_ORDER) {
      const participant = room.seats[seat].participant
      const participantProfileId =
        participant?.identity.profileId ?? participant?.publicProfile?.profileId ?? null

      if (
        participant?.kind === 'human' &&
        participantProfileId === profileId &&
        // Loose (== null), не strict — legacy restored участници могат да
        // имат permanentlyLeftAt===undefined, ако по някаква причина не са
        // минали през prepareRestoredRoomForServerStart нормализацията
        // (напр. диагностика/друг read path). undefined и null трябва да
        // означават едно и също: "не е отбелязано доброволно напускане".
        participant.permanentlyLeftAt == null
      ) {
        return true
      }
    }
  }

  return false
}

function findProfileInGameSession(
  profileId: string,
): { roomId: string; reconnectToken: string } | null {
  for (const room of Object.values(serverState.rooms)) {
    const phase = room.game.phase
    if (phase === null || phase === 'finished') continue
    for (const seat of SERVER_SEAT_ORDER) {
      const participant = room.seats[seat].participant
      const participantProfileId =
        participant?.identity.profileId ?? participant?.publicProfile?.profileId ?? null
      if (
        participant?.kind === 'human' &&
        participantProfileId === profileId &&
        participant.reconnectToken !== null
      ) {
        return { roomId: room.id, reconnectToken: participant.reconnectToken }
      }
    }
  }
  return null
}

function sendSessionInGameIfNeeded(
  connectionId: ConnectionId,
  profileId: string,
): boolean {
  const gameSession = findProfileInGameSession(profileId)
  if (gameSession === null) {
    return false
  }

  removeConnectionFromMatchmaking(connectionId)
  safeSendToConnection(connectionId, {
    type: 'session_in_game',
    roomId: gameSession.roomId,
    reconnectToken: gameSession.reconnectToken,
  })
  return true
}

function displaceProfileConnections(
  profileId: string,
  exceptConnectionId: ConnectionId,
): void {
  for (const conn of Object.values(serverState.connections)) {
    if (
      conn.profileId !== profileId ||
      conn.id === exceptConnectionId ||
      conn.status !== 'connected'
    ) {
      continue
    }

    const socket = socketRegistry.get(conn.id)
    if (socket && socket.readyState === WebSocket.OPEN) {
      sendJsonMessage(socket, { type: 'session_displaced' })
      socket.close()
    }

    removeConnectionFromMatchmaking(conn.id)
    const result = handleDisconnect(serverState, conn.id)
    serverState = result.room === null
      ? result.serverState
      : commitServerRoomWithSnapshot(result.room, result.serverState)

    if (result.room !== null) {
      broadcastRoomSnapshots(result.room, socketRegistry)
    }
  }
}

function isRoomAtMatchEndedPhase(room: ServerRoom): boolean {
  const authoritativeState = room.game.authoritativeState

  return (
    room.status === 'finished' ||
    (isRuntimeAuthoritativeState(authoritativeState) &&
      authoritativeState.phase === 'match-ended')
  )
}

function shouldRunMatchCompletionSideEffects(
  currentRoom: ServerRoom,
  nextRoom: ServerRoom,
): boolean {
  return (
    !isRoomAtMatchEndedPhase(currentRoom) &&
    isRoomAtMatchEndedPhase(nextRoom)
  )
}

type RoundCapotTransition = {
  capotTeam: Team
  roundKey: string
}

function getRoundCapotTransition(
  previousRoom: ServerRoom,
  nextRoom: ServerRoom,
): RoundCapotTransition | null {
  const prevState = previousRoom.game.authoritativeState
  const nextState = nextRoom.game.authoritativeState

  if (
    prevState === null ||
    !('phase' in prevState) ||
    prevState.phase !== 'playing'
  ) {
    return null
  }

  if (
    nextState === null ||
    !('phase' in nextState) ||
    nextState.phase !== 'scoring'
  ) {
    return null
  }

  const scoring = nextState.scoring
  if (scoring === null || !scoring.isCapotRound) {
    return null
  }

  const tricksWon = scoring.rawHandTricksWon
  const capotTeam: Team = tricksWon.teamA === 8 ? 'A' : 'B'

  const prevScore = prevState.score.match
  const dealerSeat = prevState.round.dealerSeat ?? 'bottom'
  const roundKey = `${dealerSeat}:${prevScore.teamA}:${prevScore.teamB}`

  return { capotTeam, roundKey }
}

type RoundContraTransition = {
  winnerTeam: Team
  roundKey: string
}

function getRoundContraTransition(
  previousRoom: ServerRoom,
  nextRoom: ServerRoom,
): RoundContraTransition | null {
  const prevState = previousRoom.game.authoritativeState
  const nextState = nextRoom.game.authoritativeState

  if (
    prevState === null ||
    !('phase' in prevState) ||
    prevState.phase !== 'playing'
  ) {
    return null
  }

  if (
    nextState === null ||
    !('phase' in nextState) ||
    nextState.phase !== 'scoring'
  ) {
    return null
  }

  const scoring = nextState.scoring
  if (scoring === null || scoring.counterMultiplier <= 1) {
    return null
  }

  // Winner is the team with more official round points.
  // officialRoundPoints already accounts for inside/capot rules.
  const pts = scoring.officialRoundPoints
  if (pts.teamA === pts.teamB) return null
  const winnerTeam: Team = pts.teamA > pts.teamB ? 'A' : 'B'

  const prevScore = prevState.score.match
  const dealerSeat = prevState.round.dealerSeat ?? 'bottom'
  const roundKey = `${dealerSeat}:${prevScore.teamA}:${prevScore.teamB}`

  return { winnerTeam, roundKey }
}

function getPartnerSeat(seat: Seat): Seat {
  if (seat === 'bottom') return 'top'
  if (seat === 'top') return 'bottom'
  if (seat === 'left') return 'right'
  return 'left'
}

function shouldApplyTableExitPenalty(room: ServerRoom): boolean {
  if (room.config.isGuestTrial || isTournamentMatchRoom(room)) {
    return false
  }

  const stakeAmount = room.config.stakeAmount ?? null
  const phase = room.game.phase

  return (
    phase !== null &&
    phase !== 'bootstrap' &&
    !isRoomAtMatchEndedPhase(room) &&
    Number.isInteger(stakeAmount) &&
    stakeAmount !== null &&
    stakeAmount > 0
  )
}

function sendChatNotificationToProfile(input: {
  recipientProfileId: string
  friendshipId: string
  senderProfileId: string
  messageId: string
  shouldNotify: boolean
}): void {
  const senderProfile = playerProgressStore.getPublicProfile(input.senderProfileId)
  if (senderProfile === null) {
    return
  }

  for (const connection of Object.values(serverState.connections)) {
    if (
      connection.profileId !== input.recipientProfileId ||
      connection.status !== 'connected'
    ) {
      continue
    }

    safeSendToConnection(connection.id, {
      type: 'chat_message_received',
      friendshipId: input.friendshipId,
      senderProfileId: input.senderProfileId,
      fromDisplayName: senderProfile.displayName,
      fromAvatarUrl: senderProfile.avatarUrl,
      messageId: input.messageId,
      shouldNotify: input.shouldNotify,
    })
  }
}

function getQueueCountsByStake(): Record<string, number> {
  const counts: Record<string, number> = {}

  for (const stake of SUPPORTED_MATCH_STAKES) {
    const searchingEntries = getSearchingEntriesByStake(
      matchmakingState.queueEntries,
      stake,
    )

    if (searchingEntries.length > 0) {
      counts[String(stake)] = searchingEntries.length
    }
  }

  return counts
}

function createQueuedPlayerPreview(entry: MatchmakingQueueEntry): {
  id: string
  name: string
  avatarUrl: string | null
  isBot?: boolean
} {
  return {
    id: `queued-${entry.entryId}`,
    name: entry.displayName.trim() || 'Играч',
    avatarUrl: entry.publicProfile?.avatarUrl ?? null,
    isBot: false,
  }
}

function createQueuedPlayerPreviews(
  entries: MatchmakingQueueEntry[],
  exceptConnectionId: ConnectionId,
): Array<{ id: string; name: string; avatarUrl: string | null; isBot?: boolean }> {
  return entries
    .filter((entry) => entry.connectionId !== exceptConnectionId)
    .map(createQueuedPlayerPreview)
}

function removeConnectionFromMatchmaking(connectionId: ConnectionId): boolean {
  const existingEntry = getQueueEntryByConnectionId(
    matchmakingState.queueEntries,
    connectionId,
  )

  if (existingEntry === null) {
    return false
  }

  if (existingEntry.stakePaid && existingEntry.profileId !== null) {
    const refundResult = matchEconomyStore.refundQueueStake(
      existingEntry.entryId,
      existingEntry.profileId,
      existingEntry.stake,
    )

    if (!refundResult.ok) {
      console.error(
        `[match-economy] stake refund failed entry=${existingEntry.entryId}: ${refundResult.message}`,
      )
    }
  }

  matchmakingState = {
    ...matchmakingState,
    queueEntries: removeQueueEntryByConnectionId(
      matchmakingState.queueEntries,
      connectionId,
    ),
  }

  activityCounters.incrementRooms('matchmakingLeave')
  broadcastMatchmakingStatusForStake(existingEntry.stake)
  return true
}

function sendMatchmakingStatusToConnection(
  connectionId: ConnectionId,
  stake: MatchStake,
  localStakeDeducted?: true,
): void {
  const ownEntry = getQueueEntryByConnectionId(matchmakingState.queueEntries, connectionId)

  if (ownEntry === null || ownEntry.stake !== stake) {
    return
  }

  const searchingEntries = getSearchingEntriesByStake(
    matchmakingState.queueEntries,
    stake,
  ).sort((a, b) => a.joinedAt - b.joinedAt)

  const oldestEntry = searchingEntries[0]
  const now = Date.now()
  const countdownEndsAt = oldestEntry?.expiresAt ?? ownEntry.expiresAt
  const stakeMinLevel = matchRoomsStore.getRoom(stake)?.minLevel ?? 1
  const previewBotDisplayNames = stakeMinLevel > 7
    ? []
    : selectMatchmakingBotProfiles({
        stake,
        count: Math.max(0, MATCH_PLAYERS_REQUIRED - searchingEntries.length),
        selectionSeed: createMatchmakingBotSelectionSeed(stake, searchingEntries),
        minLevel: stakeMinLevel,
      }).map((profile) => profile.identity.displayName)
  const totalDurationMs = ownEntry.expiresAt - ownEntry.joinedAt

  safeSendToConnection(connectionId, {
    type: 'matchmaking_status',
    stake,
    queuedPlayers: searchingEntries.length,
    requiredPlayers: MATCH_PLAYERS_REQUIRED,
    countdownEndsAt,
    remainingMs: Math.max(0, countdownEndsAt - now),
    totalDurationMs,
    previewBotDisplayNames,
    queuedPlayerPreviews: createQueuedPlayerPreviews(searchingEntries, connectionId),
    ...(localStakeDeducted === true ? { localStakeDeducted: true as const } : {}),
  })
}

function broadcastMatchmakingStatusForStake(stake: MatchStake): void {
  const searchingEntries = getSearchingEntriesByStake(
    matchmakingState.queueEntries,
    stake,
  )

  for (const entry of searchingEntries) {
    sendMatchmakingStatusToConnection(entry.connectionId, stake)
  }
}

function cleanupPendingGroup(groupId: string): void {
  matchmakingState = {
    ...matchmakingState,
    pendingGroups: matchmakingState.pendingGroups.filter(
      (group) => group.groupId !== groupId,
    ),
  }
}

function processMatchmaking(): void {
  try {
    processMatchmakingUnsafe()
  } catch (error) {
    console.error('[matchmaking] processing error', error)
  }
}

function processMatchmakingUnsafe(): void {
  const earlyDebitNow = Date.now()
  const entriesToEarlyDebit = matchmakingState.queueEntries.filter((entry) => {
    if (entry.stakePaid || entry.profileId === null) return false
    if (earlyDebitNow < entry.expiresAt - EARLY_BOT_FILL_DEBIT_MS) return false
    const stakeMinLevel = matchRoomsStore.getRoom(entry.stake)?.minLevel ?? 1
    if (stakeMinLevel > 7) return false
    const humanCountForStake = getSearchingEntriesByStake(
      matchmakingState.queueEntries,
      entry.stake,
    ).length
    return humanCountForStake === 1
  })

  for (const entry of entriesToEarlyDebit) {
    const stakeResult = matchEconomyStore.collectQueueStake(
      entry.entryId,
      entry.profileId!,
      entry.stake,
    )

    if (stakeResult.ok) {
      markMatchmakingEntriesStakePaid([entry.entryId])
      const searchingEntries = getSearchingEntriesByStake(
        matchmakingState.queueEntries,
        entry.stake,
      ).sort((a, b) => a.joinedAt - b.joinedAt)
      safeSendToConnection(entry.connectionId, {
        type: 'matchmaking_status',
        stake: entry.stake,
        queuedPlayers: 1,
        requiredPlayers: MATCH_PLAYERS_REQUIRED,
        countdownEndsAt: entry.expiresAt,
        remainingMs: Math.max(0, entry.expiresAt - earlyDebitNow),
        queuedPlayerPreviews: createQueuedPlayerPreviews(searchingEntries, entry.connectionId),
        localStakeDeducted: true,
      })
    } else {
      matchmakingState = {
        ...matchmakingState,
        queueEntries: removeQueueEntryByConnectionId(
          matchmakingState.queueEntries,
          entry.connectionId,
        ),
      }
      safeSendToConnection(entry.connectionId, {
        type: 'error',
        message: stakeResult.message,
      })
    }
  }

  const now = earlyDebitNow

  if (now < matchmakingCapacityRetryAt) {
    return
  }

  let guard = 0

  while (guard < 20) {
    guard += 1

    let result: ReturnType<typeof tryCreatePendingMatchGroup>

    try {
      result = tryCreatePendingMatchGroup(
        matchmakingState,
        (a, b) => blockStore.isBlocked(a, b),
        (stake, profileId, baseName, completedGamesCount, wonGamesCount) => {
          const stakeMinLevel = matchRoomsStore.getRoom(stake)?.minLevel ?? 1
          if (stakeMinLevel > 7) return null
          const profile = playerProgressStore.createTemporaryBotProfile(profileId, baseName, completedGamesCount, wonGamesCount)
          return profile.displayName
        },
      )
    } catch (error) {
      console.error('[matchmaking] failed to create match group:', error)
      for (const stake of SUPPORTED_MATCH_STAKES) {
        const expiredEntries = getSearchingEntriesByStake(matchmakingState.queueEntries, stake)
          .filter((e) => isQueueEntryExpired(e))
        for (const entry of expiredEntries) {
          if (entry.stakePaid && entry.profileId !== null) {
            const refundResult = matchEconomyStore.refundQueueStake(
              entry.entryId,
              entry.profileId,
              entry.stake,
            )
            if (!refundResult.ok) {
              console.error(`[match-economy] stake refund failed entry=${entry.entryId}: ${refundResult.message}`)
            }
          }
          safeSendToConnection(entry.connectionId, {
            type: 'matchmaking_expired',
            stake: entry.stake,
          })
        }
        if (expiredEntries.length > 0) {
          const expiredIds = new Set(expiredEntries.map((e) => e.entryId))
          matchmakingState = {
            ...matchmakingState,
            queueEntries: matchmakingState.queueEntries.filter((e) => !expiredIds.has(e.entryId)),
          }
        }
      }
      break
    }

    if (result.room === null || result.group === null) {
      return
    }

    activityCounters.incrementRooms('matchmakingMatchFound')

    const initializedRoom = initializeRoomAuthoritativeGameState(result.room)

    const ensureResult = activeRoomRuntime.ensureRoom(initializedRoom)

    if (!ensureResult.ok) {
      cleanupTempBotsFromRoom(initializedRoom)
      matchmakingCapacityRetryAt = now + MATCHMAKING_NO_CAPACITY_COOLDOWN_MS
      return
    }

    let stakeCollectionFailed = false
    const justDebitedConnectionIds = new Set<ConnectionId>()
    const justDebitedEntries: (typeof result.group.matchedHumans)[number][] = []

    for (const matchedEntry of result.group.matchedHumans) {
      if (matchedEntry.stakePaid) {
        continue
      }

      if (matchedEntry.profileId === null) {
        safeSendToConnection(matchedEntry.connectionId, {
          type: 'error',
          message: 'Профилът не беше намерен за залога.',
        })
        stakeCollectionFailed = true
        continue
      }

      const stakeResult = matchEconomyStore.collectQueueStake(
        matchedEntry.entryId,
        matchedEntry.profileId,
        result.group.stake,
      )

      if (!stakeResult.ok) {
        safeSendToConnection(matchedEntry.connectionId, {
          type: 'error',
          message: stakeResult.message,
        })
        stakeCollectionFailed = true
      } else {
        justDebitedConnectionIds.add(matchedEntry.connectionId)
        justDebitedEntries.push(matchedEntry)
      }
    }

    if (stakeCollectionFailed) {
      for (const entry of justDebitedEntries) {
        const refundResult = matchEconomyStore.refundQueueStake(
          entry.entryId,
          entry.profileId!,
          result.group.stake,
        )
        if (!refundResult.ok) {
          console.error(`[match-economy] stake refund failed entry=${entry.entryId}: ${refundResult.message}`)
        }
      }
      activeRoomRuntime.removeRoom(initializedRoom.id)
      cleanupTempBotsFromRoom(initializedRoom)
      broadcastMatchmakingStatusForStake(result.group.stake)
      return
    }

    const botStakeResult = matchEconomyStore.collectBotStakes(initializedRoom, result.group.stake)
    if (!botStakeResult.ok) {
      console.error(`[match-economy] bot stake collection failed room=${initializedRoom.id}: ${botStakeResult.message}`)
    }

    matchmakingState = result.matchmakingState

    const debitNotifyNow = Date.now()
    for (const connectionId of justDebitedConnectionIds) {
      safeSendToConnection(connectionId, {
        type: 'matchmaking_status',
        stake: result.group.stake,
        queuedPlayers: result.group.matchedHumans.length,
        requiredPlayers: MATCH_PLAYERS_REQUIRED,
        countdownEndsAt: debitNotifyNow,
        remainingMs: 0,
        localStakeDeducted: true,
      })
    }

    let nextServerState = commitServerRoomWithSnapshot(initializedRoom)

    for (const matchedEntry of result.group.matchedHumans) {
      const connection = getConnectionById(nextServerState, matchedEntry.connectionId)

      if (connection === null) {
        continue
      }

      const seatAssignment = result.group.seatAssignments.find(
        (assignment) =>
          assignment.playerId === matchedEntry.playerId && assignment.isBot === false,
      )

      if (!seatAssignment) {
        continue
      }

      const attachedConnection = attachConnectionToRoomSeat(
        connection,
        matchedEntry.connectionId,
        initializedRoom,
        seatAssignment.seat,
      )

      nextServerState = updateServerConnectionInState(
        nextServerState,
        matchedEntry.connectionId,
        attachedConnection,
      )

      safeSendToConnection(matchedEntry.connectionId, {
        type: 'match_found',
        roomId: initializedRoom.id,
        seat: seatAssignment.seat,
        stake: result.group.stake,
        humanPlayers: result.group.matchedHumans.length,
        botPlayers: result.group.addedBots.length,
        shouldStartImmediately: result.group.shouldStartImmediately,
      })
    }

    serverState = nextServerState

    broadcastRoomSnapshots(initializedRoom, socketRegistry)
    cleanupPendingGroup(result.group.groupId)

    console.log(
      `[matchmaking] room created ${initializedRoom.id} | stake=${result.group.stake} | humans=${result.group.matchedHumans.length} | bots=${result.group.addedBots.length} | immediate=${result.group.shouldStartImmediately}`,
    )

    broadcastMatchmakingStatusForStake(result.group.stake)
  }
}

function sofiaDateString(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Sofia' }).format(new Date())
}

function sendJsonResponse(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  })
  res.end(JSON.stringify(payload))
}

function readJsonRequestBody(
  req: IncomingMessage,
  maxBytes: number = 64_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''

    req.setEncoding('utf8')

    req.on('data', (chunk: string) => {
      body += chunk

      if (Buffer.byteLength(body, 'utf8') > maxBytes) {
        reject(new Error('Request body is too large.'))
        req.destroy()
      }
    })

    req.on('end', () => {
      if (!body.trim()) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(body) as unknown)
      } catch {
        reject(new Error('Invalid JSON body.'))
      }
    })

    req.on('error', reject)
  })
}

function readRawRequestBody(
  req: IncomingMessage,
  maxBytes: number = 64_000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.length

      if (total > maxBytes) {
        reject(new Error('Request body is too large.'))
        req.destroy()
      }
    })

    req.on('end', () => {
      resolve(Buffer.concat(chunks))
    })

    req.on('error', reject)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getStringField(
  value: Record<string, unknown>,
  key: string,
): string {
  const field = value[key]

  return typeof field === 'string' ? field : ''
}

function getNumberField(
  value: Record<string, unknown>,
  key: string,
): number | null {
  const field = value[key]

  return typeof field === 'number' && Number.isFinite(field) ? field : null
}

const VISITOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VISITOR_INTERNAL_PATH_RE = /^\/[A-Za-z0-9/_\-.%]*$/
const VISITOR_NAVIGATION_TYPES = new Set<SiteVisitNavigationType>([
  'navigate',
  'reload',
  'back_forward',
  'spa',
])
const VISITOR_PAGE_VIEW_BODY_KEYS = new Set([
  'anonymousVisitorId',
  'pageViewId',
  'path',
  'navigationType',
  'referrer',
  'utm',
  'viewLayout',
  'isEntry',
])
const VISITOR_UTM_KEYS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
])
const VISITOR_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000
const VISITOR_RATE_LIMIT_MAX_PER_IP = 120
const VISITOR_RATE_LIMIT_MAX_PER_VISITOR = 60
const VISITOR_RATE_LIMIT_CLEANUP_INTERVAL_MS = 60 * 1000
const VISITOR_RATE_LIMIT_MAX_KEYS = 5000

type VisitorRateLimitEntry = {
  count: number
  windowStartedAt: number
  lastSeenAt: number
}

const visitorRateLimitByIp = new Map<string, VisitorRateLimitEntry>()
const visitorRateLimitByVisitorId = new Map<string, VisitorRateLimitEntry>()
let visitorRateLimitLastCleanupAt = 0

type VisitorPageViewPayload = {
  anonymousVisitorId: string
  pageViewId: string
  path: string
  navigationType: SiteVisitNavigationType
  referrer: string | null
  source: string
  attributionReferrer: string | null
  attributionSource: string | null
  utm: SiteVisitUtmParams
  viewLayout: SiteVisitViewLayout | null
  isEntry: boolean
}

function hasControlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

function cleanupVisitorRateLimitState(now: number = Date.now()): void {
  if (
    now - visitorRateLimitLastCleanupAt < VISITOR_RATE_LIMIT_CLEANUP_INTERVAL_MS &&
    visitorRateLimitByIp.size <= VISITOR_RATE_LIMIT_MAX_KEYS &&
    visitorRateLimitByVisitorId.size <= VISITOR_RATE_LIMIT_MAX_KEYS
  ) {
    return
  }

  visitorRateLimitLastCleanupAt = now

  const cleanupMap = (entries: Map<string, VisitorRateLimitEntry>): void => {
    for (const [key, entry] of entries.entries()) {
      if (now - entry.windowStartedAt >= VISITOR_RATE_LIMIT_WINDOW_MS) {
        entries.delete(key)
      }
    }

    if (entries.size <= VISITOR_RATE_LIMIT_MAX_KEYS) {
      return
    }

    const sortedKeys = [...entries.entries()]
      .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)
      .map(([key]) => key)
    const deleteCount = entries.size - VISITOR_RATE_LIMIT_MAX_KEYS
    for (let i = 0; i < deleteCount; i++) {
      entries.delete(sortedKeys[i]!)
    }
  }

  cleanupMap(visitorRateLimitByIp)
  cleanupMap(visitorRateLimitByVisitorId)
}

function checkVisitorRateLimit(
  entries: Map<string, VisitorRateLimitEntry>,
  key: string,
  limit: number,
  now: number = Date.now(),
): boolean {
  cleanupVisitorRateLimitState(now)

  const existing = entries.get(key)
  if (!existing || now - existing.windowStartedAt >= VISITOR_RATE_LIMIT_WINDOW_MS) {
    entries.set(key, { count: 1, windowStartedAt: now, lastSeenAt: now })
    return true
  }

  existing.count += 1
  existing.lastSeenAt = now
  return existing.count <= limit
}

function normalizeRequestHostname(value: string | null): string | null {
  if (value === null) {
    return null
  }

  const trimmed = value.trim().toLowerCase()
  if (!trimmed) {
    return null
  }

  if (trimmed.startsWith('[')) {
    const closingIndex = trimmed.indexOf(']')
    return closingIndex > 0 ? trimmed.slice(1, closingIndex) : null
  }

  return trimmed.split(':')[0] || null
}

function isLocalDevelopmentHostname(hostname: string | null): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function isPikaHostname(hostname: string | null): boolean {
  return hostname === 'pika.bg' || hostname?.endsWith('.pika.bg') === true
}

function getRequestHostname(req: IncomingMessage): string | null {
  return normalizeRequestHostname(getFirstHeaderValue(req.headers.host))
}

function isInternalVisitorReferrer(referrer: string, req: IncomingMessage): boolean {
  let referrerHostname: string | null
  try {
    referrerHostname = new URL(referrer).hostname.toLowerCase()
  } catch {
    return false
  }

  const requestHostname = getRequestHostname(req)
  if (referrerHostname === requestHostname) {
    return true
  }

  if (isLocalDevelopmentHostname(referrerHostname) && isLocalDevelopmentHostname(requestHostname)) {
    return true
  }

  return isPikaHostname(referrerHostname) && isPikaHostname(requestHostname)
}

function isAllowedVisitorRequestOrigin(req: IncomingMessage): boolean {
  const fetchSite = getFirstHeaderValue(req.headers['sec-fetch-site'])?.toLowerCase() ?? null
  if (fetchSite === 'cross-site') {
    return false
  }

  const origin = getFirstHeaderValue(req.headers.origin)
  if (origin === null) {
    return true
  }

  let originHostname: string | null
  try {
    originHostname = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }

  const requestHostname = getRequestHostname(req)
  if (originHostname === requestHostname) {
    return true
  }

  if (isLocalDevelopmentHostname(originHostname) && isLocalDevelopmentHostname(requestHostname)) {
    return true
  }

  return isPikaHostname(originHostname) && isPikaHostname(requestHostname)
}

function validateVisitorId(value: unknown, fieldName: string): string | { error: string } {
  if (typeof value !== 'string' || !VISITOR_UUID_RE.test(value)) {
    return { error: `${fieldName} трябва да е валиден UUID.` }
  }
  return value.toLowerCase()
}

function validateVisitorPath(value: unknown): string | { error: string } {
  if (typeof value !== 'string') {
    return { error: 'path трябва да е текст.' }
  }

  if (
    value.length === 0 ||
    value.length > 160 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('\\') ||
    hasControlChars(value) ||
    !VISITOR_INTERNAL_PATH_RE.test(value)
  ) {
    return { error: 'path трябва да е вътрешен Pika.bg path без query string.' }
  }

  return value
}

function validateNavigationType(value: unknown): SiteVisitNavigationType | { error: string } {
  if (typeof value !== 'string' || !VISITOR_NAVIGATION_TYPES.has(value as SiteVisitNavigationType)) {
    return { error: 'navigationType е невалиден.' }
  }

  return value as SiteVisitNavigationType
}

function normalizeVisitorUtmValue(
  value: unknown,
  maxLength: number,
  fieldName: string,
): string | null | { error: string } {
  if (value === undefined || value === null) {
    return null
  }

  if (typeof value !== 'string') {
    return { error: `${fieldName} трябва да е текст.` }
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  if (trimmed.length > maxLength || hasControlChars(trimmed)) {
    return { error: `${fieldName} е прекалено дълъг или невалиден.` }
  }

  return trimmed
}

function normalizeVisitorUtm(value: unknown): SiteVisitUtmParams | { error: string } {
  if (value === undefined || value === null) {
    return {
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmTerm: null,
      utmContent: null,
    }
  }

  if (!isRecord(value)) {
    return { error: 'utm трябва да е обект.' }
  }

  for (const key of Object.keys(value)) {
    if (!VISITOR_UTM_KEYS.has(key)) {
      return { error: `Непозволен UTM параметър: ${key}.` }
    }
  }

  const utmSource = normalizeVisitorUtmValue(value.utm_source, 64, 'utm_source')
  if (typeof utmSource === 'object' && utmSource !== null) return utmSource
  const utmMedium = normalizeVisitorUtmValue(value.utm_medium, 64, 'utm_medium')
  if (typeof utmMedium === 'object' && utmMedium !== null) return utmMedium
  const utmCampaign = normalizeVisitorUtmValue(value.utm_campaign, 128, 'utm_campaign')
  if (typeof utmCampaign === 'object' && utmCampaign !== null) return utmCampaign
  const utmTerm = normalizeVisitorUtmValue(value.utm_term, 128, 'utm_term')
  if (typeof utmTerm === 'object' && utmTerm !== null) return utmTerm
  const utmContent = normalizeVisitorUtmValue(value.utm_content, 128, 'utm_content')
  if (typeof utmContent === 'object' && utmContent !== null) return utmContent

  return {
    utmSource,
    utmMedium,
    utmCampaign,
    utmTerm,
    utmContent,
  }
}

function normalizeVisitorReferrer(value: unknown): string | null | { error: string } {
  if (value === undefined || value === null) {
    return null
  }

  if (typeof value !== 'string') {
    return { error: 'referrer трябва да е текст.' }
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  if (trimmed.length > 500 || hasControlChars(trimmed)) {
    return { error: 'referrer е прекалено дълъг или невалиден.' }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { error: 'referrer трябва да е валиден http/https URL.' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'referrer трябва да е валиден http/https URL.' }
  }

  const normalized = `${parsed.origin}${parsed.pathname}`
  if (normalized.length > 500 || hasControlChars(normalized)) {
    return { error: 'referrer е прекалено дълъг или невалиден.' }
  }

  return normalized
}

function hasVisitorUtm(utm: SiteVisitUtmParams): boolean {
  return (
    utm.utmSource !== null ||
    utm.utmMedium !== null ||
    utm.utmCampaign !== null ||
    utm.utmTerm !== null ||
    utm.utmContent !== null
  )
}

function deriveVisitorSource(utm: SiteVisitUtmParams, referrer: string | null, req: IncomingMessage): string {
  if (utm.utmSource !== null) {
    return utm.utmSource
  }

  if (referrer !== null) {
    if (isInternalVisitorReferrer(referrer, req)) {
      return 'internal'
    }

    try {
      return new URL(referrer).hostname || 'referral'
    } catch {
      return 'referral'
    }
  }

  return 'direct'
}

function deriveVisitorAttribution(
  utm: SiteVisitUtmParams,
  referrer: string | null,
  req: IncomingMessage,
): { attributionReferrer: string | null; attributionSource: string | null } {
  const hasUtm = hasVisitorUtm(utm)
  const externalReferrer = referrer !== null && !isInternalVisitorReferrer(referrer, req)
    ? referrer
    : null

  if (hasUtm) {
    return {
      attributionReferrer: externalReferrer,
      attributionSource: utm.utmSource ?? 'utm',
    }
  }

  if (externalReferrer !== null) {
    return {
      attributionReferrer: externalReferrer,
      attributionSource: deriveVisitorSource(utm, externalReferrer, req),
    }
  }

  return {
    attributionReferrer: null,
    attributionSource: null,
  }
}

function parseVisitorPageViewPayload(body: unknown, req: IncomingMessage): VisitorPageViewPayload | { error: string } {
  if (!isRecord(body)) {
    return { error: 'Невалидно тяло.' }
  }

  for (const key of Object.keys(body)) {
    if (!VISITOR_PAGE_VIEW_BODY_KEYS.has(key)) {
      return { error: `Непозволено поле: ${key}.` }
    }
  }

  const anonymousVisitorId = validateVisitorId(body.anonymousVisitorId, 'anonymousVisitorId')
  if (typeof anonymousVisitorId !== 'string') return anonymousVisitorId
  const pageViewId = validateVisitorId(body.pageViewId, 'pageViewId')
  if (typeof pageViewId !== 'string') return pageViewId
  const path = validateVisitorPath(body.path)
  if (typeof path !== 'string') return path
  const navigationType = validateNavigationType(body.navigationType)
  if (typeof navigationType !== 'string') return navigationType
  const referrer = normalizeVisitorReferrer(body.referrer)
  if (typeof referrer === 'object' && referrer !== null) return referrer
  const utm = normalizeVisitorUtm(body.utm)
  if ('error' in utm) return utm
  const attribution = deriveVisitorAttribution(utm, referrer, req)
  const rawLayout = body.viewLayout
  const viewLayout: SiteVisitViewLayout | null =
    rawLayout === 'mobile' || rawLayout === 'desktop' ? rawLayout : null

  // Old clients without isEntry field default to false (not counted as entries).
  // Any non-boolean or missing value is treated as false.
  const isEntry: boolean = body.isEntry === true

  return {
    anonymousVisitorId,
    pageViewId,
    path,
    navigationType,
    referrer,
    source: deriveVisitorSource(utm, referrer, req),
    attributionReferrer: attribution.attributionReferrer,
    attributionSource: attribution.attributionSource,
    utm,
    viewLayout,
    isEntry,
  }
}

function getFirstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0]?.trim() || null
  }

  return value?.trim() || null
}

function getRequestIp(req: IncomingMessage): string {
  const forwardedFor = getFirstHeaderValue(req.headers['x-forwarded-for'])
  const forwardedIp = forwardedFor?.split(',')[0]?.trim()

  if (forwardedIp) {
    return forwardedIp
  }

  return (
    getFirstHeaderValue(req.headers['cf-connecting-ip']) ??
    getFirstHeaderValue(req.headers['x-real-ip']) ??
    req.socket.remoteAddress ??
    'unknown'
  )
}

function isGuestContactRateLimited(ip: string, now: number = Date.now()): boolean {
  for (const [entryIp, entry] of guestContactRateLimitByIp.entries()) {
    if (now - entry.windowStartedAt >= GUEST_CONTACT_RATE_LIMIT_WINDOW_MS) {
      guestContactRateLimitByIp.delete(entryIp)
    }
  }

  const entry = guestContactRateLimitByIp.get(ip)

  if (!entry) {
    guestContactRateLimitByIp.set(ip, { windowStartedAt: now, count: 1 })
    return false
  }

  if (now - entry.windowStartedAt >= GUEST_CONTACT_RATE_LIMIT_WINDOW_MS) {
    guestContactRateLimitByIp.set(ip, { windowStartedAt: now, count: 1 })
    return false
  }

  if (entry.count >= GUEST_CONTACT_RATE_LIMIT_MAX_MESSAGES) {
    return true
  }

  entry.count += 1
  return false
}

function decodeImageDataUrl(value: string): Buffer | null {
  const match = /^data:image\/(png|jpe?g|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(
    value.trim(),
  )

  if (!match) {
    return null
  }

  const buffer = Buffer.from(match[2], 'base64')

  if (buffer.length === 0 || buffer.length > MAX_IMAGE_ATTACHMENT_INPUT_BYTES) {
    return null
  }

  return buffer
}

function createUploadUrl(...segments: string[]): string {
  return `${UPLOADS_ROUTE_PREFIX}${segments.map(encodeURIComponent).join('/')}`
}

async function writeWebpUploadFile(
  directoryPath: string,
  filename: string,
  buffer: Buffer,
): Promise<string> {
  await mkdir(directoryPath, { recursive: true })
  const filePath = join(directoryPath, filename)
  await writeFile(filePath, buffer)

  return filePath
}

async function deleteUploadFileByUrl(uploadUrl: string): Promise<void> {
  const trimmedUrl = uploadUrl.trim()

  if (!trimmedUrl.startsWith(UPLOADS_ROUTE_PREFIX)) {
    return
  }

  const filePath = resolveUploadRequestPath(trimmedUrl)

  if (filePath === null) {
    return
  }

  try {
    await unlink(filePath)
  } catch {
    // The DB row is the source of truth; a missing upload file is already clean.
  }
}

// Chat attachment файловете НЕ живеят под публичния UPLOADS_ROUTE_PREFIX
// (не се сервират от handleUploadsRequest), затова delete helper-ът тук
// работи директно с filename (не URL) — валидиран срещу строгия
// UUID.webp regex преди path resolve, за да е невъзможен path traversal
// дори при повреден/подправен storage_filename запис в DB.
async function deleteChatAttachmentFileByFilename(filename: string): Promise<boolean> {
  return await deleteAttachmentFileByFilename(CHAT_ATTACHMENT_UPLOADS_PATH, filename)
}

async function deleteSupportAttachmentFileByFilename(filename: string): Promise<boolean> {
  return await deleteAttachmentFileByFilename(SUPPORT_ATTACHMENT_UPLOADS_PATH, filename)
}

async function deleteTopicAttachmentFileByFilename(filename: string): Promise<boolean> {
  return await deleteAttachmentFileByFilename(TOPIC_ATTACHMENT_UPLOADS_PATH, filename)
}

// Lafche retention hotfix (виж migration коментара при
// TOPIC_MUTE_EVIDENCE_ATTACHMENT_UPLOADS_PATH) — physical copy на normal
// Lafche attachment в protected evidence-only storage, ПРЕДИ enforceLafcheRetention
// enqueue-не оригинала за cleanup. Ново random filename (не reuse на
// оригиналното) — двете storage roots пазят напълно независими namespace-и,
// нулев риск от collision. Връща null при ЛЮБОЙ грешка (source липсва,
// read/write fail) — caller-ът (enforceLafcheRetention) третира null като
// "skip този victim за този цикъл, retry следващия път", НИКОГА не
// hard-delete-ва source-а, ако copy-то не е доказано успешно.
async function copyTopicAttachmentToEvidenceStorage(sourceFilename: string): Promise<string | null> {
  if (!IMAGE_ATTACHMENT_FILENAME_PATTERN.test(sourceFilename)) {
    return null
  }
  try {
    const sourceBuffer = await readFile(join(TOPIC_ATTACHMENT_UPLOADS_PATH, sourceFilename))
    const newFilename = `${randomUUID()}.webp`
    await writeWebpAttachmentFile(TOPIC_MUTE_EVIDENCE_ATTACHMENT_UPLOADS_PATH, newFilename, sourceBuffer)
    return newFilename
  } catch (error) {
    console.error('[topics] copyTopicAttachmentToEvidenceStorage failed:', error)
    return null
  }
}

// Lafche steady-state hard retention enforcement (production hotfix — root
// cause audit-а: unbounded client-side scroll-triggered "load older" доведе
// до 900+ Lafche root nodes; LAFCHE_MESSAGE_HISTORY_LIMIT вече cap-ва
// initial REST load-а, но нищо не е пазило DB-то самото под лимита).
// Извиква се fire-and-forget СЛЕД всеки успешен нов Lafche root insert (виж
// send_topic_message handler-а по-долу) — конкретно чрез
// enqueueLafcheRetentionEnforcement(), НЕ директно.
//
// КРИТИЧНО — steady-state guard (НЕ mass-delete на legacy backlog): тази
// функция trim-ва до LIMIT В РАМКИТЕ НА ЕДНО извикване, САМО ако overshoot-ът
// (liveCount - LIMIT) е в разумен "concurrent burst" диапазон
// (LAFCHE_STEADY_STATE_BURST_TOLERANCE). Ако overshoot-ът е по-голям
// (production legacy backlog, натрупан преди този hotfix), функцията explicit
// ОТКАЗВА да пипа каквото и да е и само лог-ва предупреждение — bulk
// backlog normalization е ИЗКЛЮЧИТЕЛНО отговорност на
// scripts/lafcheRetentionCleanup.ts --mode=apply (explicit, ръчно
// задействан, extends извън normal request path), НЕ на този hook.
// Причина: първият нов Lafche пост след deploy на този hotfix НЕ трябва
// synchronously да заличи стотици/хиляди historical rows в рамките на един
// send_topic_message request.
//
// ЗАЩО BURST TOLERANCE (не просто LIMIT+1, corrective pass): real-concurrency
// тест (checkLafcheRetentionConcurrency.ts) доказа, че fire-and-forget
// извикването + awaited evidence-copy стъпката ПОЗВОЛЯВАТ реално interleaving
// между 2+ Lafche постове, пристигнали близо един до друг — post A тика
// count до LIMIT+1 и започва (евентуално await-ващо evidence-copy)
// enforcement; докато A чака, post(ове) B/C/... тикат count по-нагоре и
// техните собствени (бързи, sync, без evidence) enforcement извиквания viждат
// count > LIMIT+1 и се отказват. Със стария exact "==LIMIT+1" design това
// оставяше DB ЗАКЛЕЩЕНА над лимита завинаги (всеки следващ пост пак вижда
// >LIMIT+1 и отказва) — заради ЛЕГИТИМЕН concurrent traffic, не заради
// реален legacy backlog. Bounded loop + малка толеранс не мени safety
// гаранцията за истински backlog (стотици/хиляди редове далеч надвишават
// толеранса) — просто позволява на легитимни малки concurrent burst-ове да
// се trim-нат coherentно в рамките на serialized turns (виж по-долу).
//
// СЕРИАЛИЗАЦИЯ (corrective pass) — enqueueLafcheRetentionEnforcement()
// chain-ва последователни извиквания на promise опашка, за да НЕ overlap-ват
// две enforcement извиквания едновременно (само ЕДНО в даден момент е
// "в течение", включително docато await-ва evidence copy). Без това,
// concurrent извиквания виждат несъгласувани/stale liveCount снимки помежду
// си (виж по-горе). enforceLafcheRetentionOnce() никога не хвърля навън
// (own try/catch) — опашката никога не се "заклещва" от失败.
//
// Двуфазов design за всяка отделна victim стъпка вътре в цикъла (async
// file-copy ПРЕДИ синхронната DB транзакция, НИКОГА await ВЪТРЕ в
// BEGIN IMMEDIATE...COMMIT) — node:sqlite DatabaseSync е ЕДНА споделена
// synchronous connection за целия process (виж topicMessageStore.ts); await
// посред отворена транзакция би позволил на друг handler да изпълни
// несвързана заявка ВЪТРЕ в СЪЩАТА отворена транзакция (correctness риск) —
// затова целият filesystem copy работи ИЗЦЯЛО извън всякаква open
// transaction, а самото hard delete е чисто синхронно
// (hardDeleteRetentionVictims). НЕ insert-ва deletion fanout event/audit
// redove — retention не е moderator/self delete action (виж
// hardDeleteRetentionVictims коментара).
const LAFCHE_STEADY_STATE_BURST_TOLERANCE = 25

async function enforceLafcheRetentionOnce(): Promise<void> {
  try {
    let liveCount = topicMessageStore.countLiveRootMessages(LAFCHE_TOPIC_ID)
    if (liveCount <= LAFCHE_MESSAGE_HISTORY_LIMIT) return

    const overshoot = liveCount - LAFCHE_MESSAGE_HISTORY_LIMIT
    if (overshoot > LAFCHE_STEADY_STATE_BURST_TOLERANCE) {
      console.warn(
        `[topics] Lafche live root count (${liveCount}) е над steady-state burst tolerance ` +
        `(${LAFCHE_MESSAGE_HISTORY_LIMIT} + ${LAFCHE_STEADY_STATE_BURST_TOLERANCE}) — вероятно legacy backlog отпреди retention hotfix-а. ` +
        `НЕ mass-delete-вам от normal request path. Нормализирай явно чрез ` +
        `"tsx scripts/lafcheRetentionCleanup.ts --mode=apply" (виж --mode=dry-run за преглед първо).`,
      )
      return
    }

    // Overshoot-ът е в concurrent-burst диапазона — trim-вай итеративно
    // (ограничен loop, serialized turn) обратно до LIMIT.
    while (liveCount > LAFCHE_MESSAGE_HISTORY_LIMIT) {
      const victims = topicMessageStore.getLafcheRetentionVictims(LAFCHE_TOPIC_ID, LAFCHE_MESSAGE_HISTORY_LIMIT)
      if (victims.length === 0) return
      // getLafcheRetentionVictims връща по seq DESC (newest-of-the-victims
      // първи, виж SQL коментара в topicMessageStore.ts) — при >1 victim
      // (възможно само в bounded-loop-а тук, единичната стара
      // steady-state==LIMIT+1 логика винаги имаше точно 1 victim, значи
      // индексът никога не е имал значение там) ПОСЛЕДНИЯТ елемент е
      // АБСОЛЮТНО най-стария, не victims[0]. Трием винаги най-стария първи
      // (established инвариант — "trim exact oldest root").
      const victim = victims[victims.length - 1]!

      if (victim.attachmentFilename !== null) {
        // Само ако filename-ът е реферирано от поне един ЖИВ (still-shared-
        // storage) mute evidence ред трябва да се copy-не — normal victim без
        // evidence reference просто ще бъде enqueue-нат за нормален cleanup
        // вътре в hardDeleteRetentionVictims.
        const referencedByEvidence = topicModerationStore.getActiveEvidenceAttachmentReferences([victim.attachmentFilename])
        if (referencedByEvidence.has(victim.attachmentFilename)) {
          const copiedFilename = await copyTopicAttachmentToEvidenceStorage(victim.attachmentFilename)
          if (copiedFilename === null) {
            // Copy неуспешен (напр. source файлът временно недостъпен) —
            // retention НЕ трябва да hard-delete-ва source-а в ТОЗИ цикъл, за
            // да не осиротее evidence-ът. Спираме ЦЕЛИЯ loop тук (не skip-ваме
            // към следващия victim) — следващият root insert ще retry-не
            // автоматично (getLafcheRetentionVictims пак ще върне СЪЩИЯ
            // oldest victim първи).
            return
          }
          topicModerationStore.repointMuteEvidenceAttachmentToEvidenceCopy(victim.attachmentFilename, copiedFilename)
        }
      }

      // Благодарение на серилизацията (enqueueLafcheRetentionEnforcement)
      // НИКОЕ друго enforceLafcheRetentionOnce() извикване не тече конкурентно
      // с това — единствената причина victim-ът да е изчезнал междувременно е
      // НЕСВЪРЗАНО concurrent действие (напр. moderator hard-delete чрез
      // deleteMessage) по време на await-а по-горе, не race с друг retention
      // цикъл. Ре-проверяваме explicit вместо да приемаме stale ID е все още валиден.
      if (topicMessageStore.getMessageById(victim.messageId) === null) {
        liveCount = topicMessageStore.countLiveRootMessages(LAFCHE_TOPIC_ID)
        continue
      }

      topicMessageStore.hardDeleteRetentionVictims(LAFCHE_TOPIC_ID, [victim.messageId])
      liveCount = topicMessageStore.countLiveRootMessages(LAFCHE_TOPIC_ID)
    }
  } catch (error) {
    console.error('[topics] enforceLafcheRetentionOnce failed:', error)
  }
}

// Promise-опашка сериализираща последователни enforceLafcheRetentionOnce()
// извиквания (виж rationale-а по-горе) — enforceLafcheRetentionOnce()
// никога не хвърля (own try/catch), но `.catch` тук е defense-in-depth: ако
// бъдещ edit случайно въведе escaping error, опашката пак продължава напред
// вместо permanently да се "заклещи" (следващите enqueue-вания никога не
// биха изпълнили job-а си, ако tail promise остане rejected завинаги).
let lafcheRetentionEnforcementQueueTail: Promise<void> = Promise.resolve()

function enqueueLafcheRetentionEnforcement(): void {
  lafcheRetentionEnforcementQueueTail = lafcheRetentionEnforcementQueueTail.then(
    () => enforceLafcheRetentionOnce(),
    () => enforceLafcheRetentionOnce(),
  )
}

type ProfileImageProcessingError =
  | 'decode_failed'
  | 'unsupported_format'
  | 'empty_dimensions'
  | 'crop_out_of_bounds'
  | 'processing_failed'

type ProfileImageProcessingResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; error: ProfileImageProcessingError; detectedFormat?: string }

function isSupportedProfileImageFormat(format: string | undefined): boolean {
  return format === 'jpeg' || format === 'png' || format === 'webp'
}

function getProfileImageProcessingMessage(error: ProfileImageProcessingError): string {
  if (error === 'unsupported_format') {
    return 'Този формат не се поддържа. Моля, изберете JPG, PNG или WebP.'
  }
  if (error === 'crop_out_of_bounds') {
    return 'Избраният квадрат е извън снимката.'
  }
  if (error === 'empty_dimensions') {
    return 'Снимката е празна или не може да бъде прочетена.'
  }
  return 'Снимката е повредена или невалидна.'
}

function logProfileImageUploadFailure(input: {
  flow: 'avatar' | 'gallery'
  stage: string
  inputBytes: number
  errorCode: string
  detectedFormat?: string
}): void {
  console.warn('[profile-image-upload]', {
    flow: input.flow,
    stage: input.stage,
    inputBytes: input.inputBytes,
    errorCode: input.errorCode,
    detectedFormat: input.detectedFormat ?? null,
  })
}

async function createCroppedAvatarWebp(input: {
  imageBuffer: Buffer
  cropX: number
  cropY: number
  cropSize: number
}): Promise<ProfileImageProcessingResult> {
  const metadata = await sharp(input.imageBuffer).metadata().catch(() => null)

  if (metadata === null) {
    return { ok: false, error: 'decode_failed' }
  }

  if (!isSupportedProfileImageFormat(metadata.format)) {
    return { ok: false, error: 'unsupported_format', detectedFormat: metadata.format }
  }

  const rotated = sharp(input.imageBuffer).rotate()
  const rotatedMetadata = await rotated.metadata().catch(() => null)
  const imageWidth = rotatedMetadata?.width ?? metadata.width ?? 0
  const imageHeight = rotatedMetadata?.height ?? metadata.height ?? 0

  if (imageWidth <= 0 || imageHeight <= 0) {
    return { ok: false, error: 'empty_dimensions', detectedFormat: metadata.format }
  }

  const left = Math.round(input.cropX)
  const top = Math.round(input.cropY)
  const size = Math.round(input.cropSize)

  if (
    left < 0 ||
    top < 0 ||
    size < 16 ||
    left + size > imageWidth ||
    top + size > imageHeight
  ) {
    return { ok: false, error: 'crop_out_of_bounds', detectedFormat: metadata.format }
  }

  const buffer = await sharp(input.imageBuffer)
    .rotate()
    .extract({
      left,
      top,
      width: size,
      height: size,
    })
    .resize(250, 250, {
      fit: 'cover',
      withoutEnlargement: false,
    })
    .webp({ quality: 86 })
    .toBuffer()
    .catch(() => null)

  return buffer === null
    ? { ok: false, error: 'processing_failed', detectedFormat: metadata.format }
    : { ok: true, buffer }
}

async function createGalleryImageWebp(imageBuffer: Buffer): Promise<ProfileImageProcessingResult> {
  const metadata = await sharp(imageBuffer).metadata().catch(() => null)

  if (metadata === null) {
    return { ok: false, error: 'decode_failed' }
  }

  if (!isSupportedProfileImageFormat(metadata.format)) {
    return { ok: false, error: 'unsupported_format', detectedFormat: metadata.format }
  }

  const imageWidth = metadata.width ?? 0
  const imageHeight = metadata.height ?? 0

  if (imageWidth <= 0 || imageHeight <= 0) {
    return { ok: false, error: 'empty_dimensions', detectedFormat: metadata.format }
  }

  const buffer = await sharp(imageBuffer)
    .rotate()
    .resize(800, 800, {
      fit: 'cover',
      position: 'centre',
      withoutEnlargement: false,
    })
    .webp({ quality: 80 })
    .toBuffer()
    .catch(() => null)

  return buffer === null
    ? { ok: false, error: 'processing_failed', detectedFormat: metadata.format }
    : { ok: true, buffer }
}

// Личен чат — снимка към съобщение. За разлика от avatar/gallery (fit:
// 'cover', фиксиран квадрат), тук пазим оригиналните пропорции (fit:
// 'inside') — резултатът е снимка, не profile thumbnail.
//
// Проверката "реален формат ∈ {jpeg, png, webp}" ПРЕДИ resize е explicit
// whitelist, отделен слой защита ОТГОРЕ на глобалния sharp.block()
// (VipsForeignLoadNsgif/Tiff/Vips defense-in-depth от началото на файла) —
// sharp.block() е blacklist (блокира конкретни опасни loader-и), докато
// тук изрично разрешаваме само трите позволени формата, вместо да разчитаме
// единствено на "не е в blacklist-а".
//
// .rotate() без аргументи чете EXIF Orientation тага и физически завърта
// пикселите, после НЕ пренася EXIF/ICC/XMP към изхода — sharp по подразбиране
// strip-ва metadata освен ако не се извика .withMetadata() (нарочно НЕ се
// вика тук).
async function createChatAttachmentWebp(
  imageBuffer: Buffer,
): Promise<{ buffer: Buffer; width: number; height: number } | null> {
  return await processImageAttachmentToWebp(imageBuffer)
}

// ВАЖНО: whitelist само на умишлено ПУБЛИЧНИТЕ поддиректории (avatars,
// profile-gallery). chat-attachments/ живее физически под същия
// UPLOADS_ROOT_PATH (виж CHAT_ATTACHMENT_UPLOADS_PATH), но снимките в
// личния чат НЕ трябва да са достъпни без сесия/friendship проверка (виж
// handleChatAttachmentDownloadRequest) — ако тази функция разрешаваше
// всякакъв relative path под UPLOADS_ROOT_PATH (какъвто беше предишният ѝ
// implementation), GET /uploads/chat-attachments/<uuid>.webp би заобиколил
// изцяло auth guard-а на защитения endpoint. Explicit whitelist на root
// поддиректорията (не само anti-traversal resolve-check) затваря тази дупка.
const PUBLIC_UPLOAD_SUBDIRECTORY_ROOTS = [
  resolve(AVATAR_UPLOADS_PATH),
  resolve(GALLERY_UPLOADS_PATH),
]

function resolveUploadRequestPath(pathname: string): string | null {
  if (!pathname.startsWith(UPLOADS_ROUTE_PREFIX)) {
    return null
  }

  const relativePath = decodeURIComponent(
    pathname.slice(UPLOADS_ROUTE_PREFIX.length),
  )
  const resolvedPath = resolve(UPLOADS_ROOT_PATH, relativePath)

  const isUnderPublicSubdirectory = PUBLIC_UPLOAD_SUBDIRECTORY_ROOTS.some((publicRoot) => {
    const publicRootWithSeparator = `${publicRoot}${/[/\\]$/.test(publicRoot) ? '' : '\\'}`
    return resolvedPath.startsWith(publicRootWithSeparator) || resolvedPath === publicRoot
  })

  if (!isUnderPublicSubdirectory) {
    return null
  }

  return resolvedPath
}

async function handleUploadsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method !== 'GET') {
    return false
  }

  const filePath = resolveUploadRequestPath(pathname)

  if (filePath === null) {
    return false
  }

  try {
    const fileStats = await stat(filePath)

    if (!fileStats.isFile()) {
      return false
    }

    const fileBuffer = await readFile(filePath)
    res.writeHead(200, {
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
    res.end(fileBuffer)
    return true
  } catch {
    return false
  }
}

async function handleGuestContactRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/contact/guest') {
    return false
  }

  if (req.method !== 'POST') {
    sendJsonResponse(res, 405, { ok: false, message: 'Методът не е позволен.' })
    return true
  }

  let body: unknown

  try {
    body = await readJsonRequestBody(req, GUEST_CONTACT_MAX_JSON_BODY_BYTES)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const isTooLarge = message.includes('too large')

    sendJsonResponse(res, isTooLarge ? 413 : 400, {
      ok: false,
      message: isTooLarge ? 'Заявката е твърде голяма.' : 'Невалидна JSON заявка.',
    })
    return true
  }

  const validation = validateGuestContactPayload(body)

  if (!validation.ok) {
    if (validation.code === 'honeypot') {
      sendJsonResponse(res, 200, {
        ok: true,
        message: 'Благодарим! Съобщението беше изпратено.',
      })
      return true
    }

    sendJsonResponse(res, 400, { ok: false, message: validation.message })
    return true
  }

  const requestIp = getRequestIp(req)

  if (isGuestContactRateLimited(requestIp)) {
    sendJsonResponse(res, 429, {
      ok: false,
      message: 'Достигнахте лимита от 3 съобщения за 30 минути. Моля, опитайте по-късно.',
    })
    return true
  }

  const storedMessage = guestContactStore.createGuestContactMessage({
    ...validation.value,
    ipAddress: requestIp === 'unknown' ? null : requestIp,
    userAgent: getFirstHeaderValue(req.headers['user-agent']),
  })
  activityCounters.incrementChat('guestContactMessages')

  try {
    const result = await sendGuestContactEmail(validation.value)

    if (!result.ok) {
      guestContactStore.markGuestContactEmailFailed(storedMessage.messageId, result.message)
      console.error('[contact] Brevo send failed:', result.message)
      sendJsonResponse(res, 500, {
        ok: false,
        message: 'Съобщението не беше изпратено. Моля, опитайте по-късно.',
      })
      return true
    }

    guestContactStore.markGuestContactEmailSent(storedMessage.messageId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    guestContactStore.markGuestContactEmailFailed(storedMessage.messageId, message)
    console.error('[contact] Unexpected Brevo send error:', error)
    sendJsonResponse(res, 500, {
      ok: false,
      message: 'Съобщението не беше изпратено. Моля, опитайте по-късно.',
    })
    return true
  }

  sendJsonResponse(res, 200, {
    ok: true,
    message: 'Благодарим! Съобщението беше изпратено.',
  })
  return true
}

async function handleSiteVisitPageViewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/visits/page-view') {
    return false
  }

  if (req.method !== 'POST') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  if (!isAllowedVisitorRequestOrigin(req)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Cross-site visitor tracking request rejected.' })
    return true
  }

  const requestIp = getRequestIp(req)
  const rateLimitIp = requestIp === 'unknown' ? req.socket.remoteAddress ?? 'unknown' : requestIp
  if (!checkVisitorRateLimit(visitorRateLimitByIp, rateLimitIp, VISITOR_RATE_LIMIT_MAX_PER_IP)) {
    sendJsonResponse(res, 429, { ok: false, message: 'Too many visitor tracking requests.' })
    return true
  }

  let body: unknown
  try {
    body = await readJsonRequestBody(req, 8_000)
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидно JSON тяло.' })
    return true
  }

  const payload = parseVisitorPageViewPayload(body, req)
  if ('error' in payload) {
    sendJsonResponse(res, 400, { ok: false, message: payload.error })
    return true
  }

  if (!checkVisitorRateLimit(
    visitorRateLimitByVisitorId,
    payload.anonymousVisitorId,
    VISITOR_RATE_LIMIT_MAX_PER_VISITOR,
  )) {
    sendJsonResponse(res, 429, { ok: false, message: 'Too many visitor tracking requests.' })
    return true
  }

  const session = authStore.getSession(getSessionTokenFromCookieHeader(req.headers.cookie))
  const profileId = session?.profile.profileId ?? null
  const userAgent = getFirstHeaderValue(req.headers['user-agent'])
  const lastDeviceType = detectDeviceType({
    userAgent,
    secChUaMobile: getFirstHeaderValue(req.headers['sec-ch-ua-mobile']),
    secChUaPlatform: getFirstHeaderValue(req.headers['sec-ch-ua-platform']),
  })
  const lastOsType = detectOsType(userAgent)
  const result = siteVisitStore.recordPageView({
    ...payload,
    profileId,
    ipAddress: requestIp === 'unknown' ? null : requestIp,
    userAgent,
    lastDeviceType,
    lastOsType,
  })

  sendJsonResponse(res, 200, {
    ok: true,
    recorded: result.recorded,
    duplicate: result.recorded ? false : result.duplicate,
  })
  return true
}

function decodeGuestContactMessageId(value: string): string | null {
  try {
    const messageId = decodeURIComponent(value).trim()
    return messageId || null
  } catch {
    return null
  }
}

function handleAdminMonitoringCurrentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  if (pathname !== '/api/admin/monitoring/current') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  // "Сървър" — read-only diagnostics, достъпно за admin И subadmin.
  if (!isAdminOrSubadminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
    return true
  }

  if (req.method !== 'GET') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  if (monitoringSampler === null) {
    sendJsonResponse(res, 503, { ok: false, message: 'Monitoring sampler not running.' })
    return true
  }

  sendJsonResponse(res, 200, { ok: true, snapshot: monitoringSampler.getSnapshot() })
  return true
}

function handleAdminMonitoringHistoryRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  if (pathname !== '/api/admin/monitoring/history') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  // "Сървър" — read-only diagnostics, достъпно за admin И subadmin.
  if (!isAdminOrSubadminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
    return true
  }

  if (req.method !== 'GET') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  const windowParam = new URLSearchParams(req.url?.split('?')[1] ?? '').get('window') ?? ''

  if (!isValidHistoryWindow(windowParam)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден параметър window. Използвай: 1h, 24h, 7d.' })
    return true
  }

  if (monitoringHistoryStore === null) {
    sendJsonResponse(res, 503, { ok: false, message: 'Monitoring history не е наличен.' })
    return true
  }

  const result = monitoringHistoryStore.queryHistory(windowParam)
  sendJsonResponse(res, 200, { ok: true, ...result })
  return true
}

function handleAdminMonitoringConnectionsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  if (pathname !== '/api/admin/monitoring/connections') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  // "Сървър" — read-only diagnostics, достъпно за admin И subadmin.
  if (!isAdminOrSubadminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
    return true
  }

  if (req.method !== 'GET') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  const diagnostic = buildWsConnectionsDiagnostic(
    socketRegistry,
    serverState.connections,
    (profileId) => findProfileInGameSession(profileId) !== null,
    (profileId) => playerProgressStore.getPublicProfile(profileId)?.displayName ?? null,
    (roomId) => roomId in serverState.rooms,
  )

  sendJsonResponse(res, 200, { ok: true, ...diagnostic })
  return true
}

const CPU_INCIDENTS_LIST_DEFAULT_LIMIT = 50

function handleAdminCpuIncidentsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  if (pathname !== '/api/admin/monitoring/cpu-incidents') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  // "Сървър" — read-only diagnostics, достъпно за admin И subadmin (същия
  // pattern като останалите /api/admin/monitoring/* endpoints).
  if (!isAdminOrSubadminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
    return true
  }

  if (req.method !== 'GET') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  if (cpuIncidentStore === null) {
    sendJsonResponse(res, 503, { ok: false, message: 'CPU incident monitoring не е наличен.' })
    return true
  }

  const limitParam = new URLSearchParams(req.url?.split('?')[1] ?? '').get('limit')
  const parsedLimit = limitParam !== null ? Number.parseInt(limitParam, 10) : CPU_INCIDENTS_LIST_DEFAULT_LIMIT
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : CPU_INCIDENTS_LIST_DEFAULT_LIMIT

  const incidents = cpuIncidentStore.listIncidents(limit)
  sendJsonResponse(res, 200, { ok: true, incidents })
  return true
}

function handleAdminCpuIncidentDetailRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  const match = /^\/api\/admin\/monitoring\/cpu-incidents\/([^/]+)$/.exec(pathname)
  if (match === null) {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isAdminOrSubadminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
    return true
  }

  if (req.method !== 'GET') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  if (cpuIncidentStore === null) {
    sendJsonResponse(res, 503, { ok: false, message: 'CPU incident monitoring не е наличен.' })
    return true
  }

  const incidentId = Number.parseInt(match[1] ?? '', 10)
  if (!Number.isFinite(incidentId)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден incident id.' })
    return true
  }

  const detail = cpuIncidentStore.getIncidentDetail(incidentId)
  if (detail === null) {
    sendJsonResponse(res, 404, { ok: false, message: 'Инцидентът не беше намерен.' })
    return true
  }

  sendJsonResponse(res, 200, { ok: true, ...detail })
  return true
}

async function handleAdminGuestContactMessagesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const messageMatch = /^\/api\/admin\/guest-contact\/messages\/([^/]+)$/.exec(pathname)
  const readMatch = /^\/api\/admin\/guest-contact\/messages\/([^/]+)\/read$/.exec(pathname)

  if (
    pathname !== '/api/admin/guest-contact/messages/unread-count' &&
    pathname !== '/api/admin/guest-contact/messages' &&
    messageMatch === null &&
    readMatch === null
  ) {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  // Съобщения от гости (contact form) — третираме като "поддръжка", само пълен admin.
  if (!isFullAdminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
    return true
  }

  if (pathname === '/api/admin/guest-contact/messages/unread-count') {
    if (req.method !== 'GET') {
      sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      unreadCount: guestContactStore.getUnreadCount(),
    })
    return true
  }

  if (pathname === '/api/admin/guest-contact/messages') {
    if (req.method !== 'GET') {
      sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      messages: guestContactStore.listMessages(),
    })
    return true
  }

  if (messageMatch !== null && req.method === 'GET') {
    const messageId = decodeGuestContactMessageId(messageMatch[1])
    if (messageId === null) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалиден messageId.' })
      return true
    }

    const message = guestContactStore.getMessageById(messageId)
    if (message === null) {
      sendJsonResponse(res, 404, { ok: false, message: 'Съобщението не беше намерено.' })
      return true
    }

    sendJsonResponse(res, 200, { ok: true, message })
    return true
  }

  if (readMatch !== null && req.method === 'PATCH') {
    const messageId = decodeGuestContactMessageId(readMatch[1])
    if (messageId === null) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалиден messageId.' })
      return true
    }

    const message = guestContactStore.markMessageRead(messageId)
    if (message === null) {
      sendJsonResponse(res, 404, { ok: false, message: 'Съобщението не беше намерено.' })
      return true
    }

    sendJsonResponse(res, 200, { ok: true, message })
    return true
  }

  sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
  return true
}

const SERVICE_UNAVAILABLE_RESET = {
  ok: false,
  code: 'EMAIL_DELIVERY_FAILED',
  message:
    'В момента не успяхме да изпратим линка за смяна на паролата. Моля, опитайте отново след няколко минути.',
} as const

async function handlePasswordResetRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (
    pathname !== '/api/auth/forgot-password' &&
    pathname !== '/api/auth/reset-password'
  ) {
    return false
  }

  if (req.method !== 'POST') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed.' })
    return true
  }

  if (passwordResetStore === null) {
    sendJsonResponse(res, 503, SERVICE_UNAVAILABLE_RESET)
    return true
  }

  const ctx: PasswordResetHandlerContext = {
    store: passwordResetStore,
    resetUrl: passwordResetUrl,
    getRequestIp: (r) => getRequestIp(r),
    sendJson: (r, status, body) => sendJsonResponse(r, status, body),
    readBody: (r) => readJsonRequestBody(r, 4_096),
  }

  if (pathname === '/api/auth/forgot-password') {
    await handleForgotPassword(req, res, ctx)
    return true
  }

  await handleResetPassword(req, res, ctx)
  return true
}

// Derived UI-only сигнал за gift modal max amount — authoritative проверката
// остава изцяло в yellowCoinGiftStore.sendGiftCore (isPikaTeamGiftMaxAmountSession
// caller-gate в route handler-ите); тук само wrap-ваме сесийния response с
// derived поле, computed от ДВЕ независими условия — legacy bypass profileId
// (isPikaTeamGiftBypassProfileId) ИЛИ role==='pika_team' (isPikaTeamGiftMaxAmountSession,
// mobile+gift-max hotfix брифа §3/§4). И двете дават еднакъв 100 000 таван —
// UI-то не различава кой от двата механизма приложи bypass-а, но authoritative
// server-side проверката (sendGiftCore) прилага съответната логика поотделно.
// null session минава непроменена.
function withPikaTeamGiftBypassFlag<T extends { profile: { profileId: string | null }; account: { role: string } } | null>(
  session: T,
): (T extends null ? null : T & {
  pikaTeamGiftMaxAmount: number | null
  pikaTeamDailyGiftLimitStatus: { limit: number; used: number; remaining: number } | null
}) | null {
  if (session === null || session.profile.profileId === null) return session as null
  const isLegacyProfileBypass = yellowCoinGiftStore.isPikaTeamGiftBypassProfileId(session.profile.profileId)
  // Директен role сравнение (не isPikaTeamGiftMaxAmountSession predicate) —
  // тук session-ът е generic T, не AuthSessionSnapshot; role стойността и
  // проверката ('pika_team') остават identical на предиката в authStore.ts.
  const isRoleBasedPikaTeam = session.account.role === 'pika_team'
  const hasHigherMaxAmount = isLegacyProfileBypass || isRoleBasedPikaTeam
  return {
    ...session,
    pikaTeamGiftMaxAmount: hasHigherMaxAmount ? yellowCoinGiftStore.getPikaTeamGiftMaxAmount() : null,
    // Initial informational snapshot за profile popup gift UI (limit/used/
    // remaining) — само за role='pika_team' (изискването не покрива legacy
    // hardcoded bypass profile, който не е задължително role='pika_team').
    // Свежи се допълнително след всеки успешен gift (viж
    // notifyGiftRecipientAndRespond), не се разчита само на session load.
    pikaTeamDailyGiftLimitStatus: isRoleBasedPikaTeam
      ? yellowCoinGiftStore.getPikaTeamDailyGiftLimitStatus(session.profile.profileId)
      : null,
  } as T extends null ? null : T & {
    pikaTeamGiftMaxAmount: number | null
    pikaTeamDailyGiftLimitStatus: { limit: number; used: number; remaining: number } | null
  }
}

async function handleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
    const session = authStore.getSession(sessionToken)

    sendJsonResponse(res, 200, {
      ok: true,
      session: withPikaTeamGiftBypassFlag(session),
    })
    return true
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
    authStore.logout(sessionToken)
    sendJsonResponse(
      res,
      200,
      { ok: true },
      { 'Set-Cookie': createClearSessionCookieHeader() },
    )
    return true
  }

  if (
    (pathname === '/api/auth/register' || pathname === '/api/auth/login') &&
    req.method === 'POST'
  ) {
    const body = await readJsonRequestBody(req)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Invalid request body.',
      })
      return true
    }

    const rawGender = getStringField(body, 'gender')
    const gender = rawGender === 'male' || rawGender === 'female' ? rawGender : null

    const result =
      pathname === '/api/auth/register'
        ? authStore.register({
            email: getStringField(body, 'email'),
            password: getStringField(body, 'password'),
            displayName: getStringField(body, 'displayName'),
            gender,
          })
        : authStore.login({
            email: getStringField(body, 'email'),
            password: getStringField(body, 'password'),
          })

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(
      res,
      200,
      {
        ok: true,
        session: withPikaTeamGiftBypassFlag(result.session),
      },
      { 'Set-Cookie': createSessionCookieHeader(result.sessionToken) },
    )
    return true
  }

  return false
}

async function handleAccountRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/account/change-password' || req.method !== 'POST') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }

  const body = await readJsonRequestBody(req)

  if (!isRecord(body)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидно тяло на заявката.' })
    return true
  }

  const result = authStore.changePassword({
    accountId: session.account.accountId,
    currentPassword: getStringField(body, 'currentPassword'),
    newPassword: getStringField(body, 'newPassword'),
  })

  if (!result.ok) {
    sendJsonResponse(res, 400, result)
    return true
  }

  sendJsonResponse(res, 200, { ok: true })
  return true
}

function handleCheckNameRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
): boolean {
  if (requestUrl.pathname !== '/api/profile/check-name') return false
  const name = requestUrl.searchParams.get('name') ?? ''
  // Изключва собствения профил на текущата сесия (ако има) от uniqueness
  // проверката — без това, собственик който проверява дали може да остане
  // на текущото си име (или леко го редактира и се върне) получава невярно
  // "Заето", защото самото име вече принадлежи на него.
  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)
  const excludedProfileId = session?.profile.profileId ?? null
  const available = playerProgressStore.isDisplayNameAvailable(name, excludedProfileId)
  sendJsonResponse(res, 200, { available })
  return true
}

async function handleProfileRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const galleryImageDeletePrefix = '/api/profile/me/gallery/'
  const isGalleryImageDeletePath = pathname.startsWith(galleryImageDeletePrefix)

  if (
    pathname !== '/api/profile/me' &&
    pathname !== '/api/profile/me/avatar' &&
    pathname !== '/api/profile/me/display-name' &&
    pathname !== '/api/profile/me/gallery' &&
    !isGalleryImageDeletePath
  ) {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null || session.profile.profileId === null) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си.',
    })
    return true
  }

  if (pathname === '/api/profile/me' && req.method === 'GET') {
    const profileId = session.profile.profileId
    if (!profileId) {
      sendJsonResponse(res, 400, { ok: false, message: 'Профилът не беше намерен.' })
      return true
    }
    const fullProfile = playerProgressStore.getPublicProfile(profileId)
    if (!fullProfile) {
      sendJsonResponse(res, 404, { ok: false, message: 'Профилът не беше намерен.' })
      return true
    }
    sendJsonResponse(res, 200, {
      ok: true,
      profile: {
        ...fullProfile,
        likesCount: likeStore.getLikesCount(profileId),
      },
    })
    return true
  }

  if (pathname === '/api/profile/me' && req.method !== 'PATCH') {
    return false
  }

  if (
    (pathname === '/api/profile/me/avatar' ||
      pathname === '/api/profile/me/display-name' ||
      pathname === '/api/profile/me/gallery') &&
    req.method !== 'POST'
  ) {
    return false
  }

  if (isGalleryImageDeletePath && req.method !== 'DELETE') {
    return false
  }

  if (isGalleryImageDeletePath) {
    const imageId = decodeURIComponent(
      pathname.slice(galleryImageDeletePrefix.length),
    ).trim()

    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(imageId)) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Невалидна снимка за изтриване.',
      })
      return true
    }

    const result = playerProgressStore.deleteProfileGalleryImage(
      session.profile.profileId,
      imageId,
    )

    if (!result.ok) {
      sendJsonResponse(res, 404, result)
      return true
    }

    await Promise.all(result.deletedImageUrls.map(deleteUploadFileByUrl))

    sendJsonResponse(res, 200, {
      ok: true,
      session: withPikaTeamGiftBypassFlag({
        ...session,
        profile: result.profile,
      }),
    })
    return true
  }

  const body = await readJsonRequestBody(req, MAX_JSON_BODY_BYTES)

  if (!isRecord(body)) {
    sendJsonResponse(res, 400, {
      ok: false,
      message: 'Invalid request body.',
    })
    return true
  }

  if (pathname === '/api/profile/me/avatar') {
    const imageBuffer = decodeImageDataUrl(getStringField(body, 'imageDataUrl'))
    const cropX = getNumberField(body, 'cropX')
    const cropY = getNumberField(body, 'cropY')
    const cropSize = getNumberField(body, 'cropSize')

    if (
      imageBuffer === null ||
      cropX === null ||
      cropY === null ||
      cropSize === null
    ) {
      logProfileImageUploadFailure({
        flow: 'avatar',
        stage: 'decode_request',
        inputBytes: 0,
        errorCode: 'invalid_payload',
      })
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Изпрати валидна снимка и избери квадрат за аватар.',
      })
      return true
    }

    const avatarResult = await createCroppedAvatarWebp({
      imageBuffer,
      cropX,
      cropY,
      cropSize,
    })

    if (!avatarResult.ok) {
      logProfileImageUploadFailure({
        flow: 'avatar',
        stage: 'process_image',
        inputBytes: imageBuffer.length,
        errorCode: avatarResult.error,
        detectedFormat: avatarResult.detectedFormat,
      })
      sendJsonResponse(res, 400, {
        ok: false,
        code: avatarResult.error,
        message: getProfileImageProcessingMessage(avatarResult.error),
      })
      return true
    }

    const oldAvatarUrl = session.profile.avatarUrl
    const avatarFilename = `${randomUUID()}.webp`

    await writeWebpUploadFile(
      AVATAR_UPLOADS_PATH,
      avatarFilename,
      avatarResult.buffer,
    )

    const avatarUrl = createUploadUrl('avatars', avatarFilename)
    const result = playerProgressStore.updateProfileAvatar(
      session.profile.profileId,
      avatarUrl,
    )

    if (!result.ok) {
      void deleteUploadFileByUrl(avatarUrl)
      sendJsonResponse(res, 400, result)
      return true
    }

    if (
      oldAvatarUrl != null &&
      oldAvatarUrl.startsWith('/uploads/avatars/') &&
      oldAvatarUrl !== avatarUrl
    ) {
      void deleteUploadFileByUrl(oldAvatarUrl)
    }

    // Обновяване на avatarUrl в активните стаи, където профилът участва
    if (!isServerShuttingDown) {
      for (const room of Object.values(serverState.rooms)) {
        for (const seat of SERVER_SEAT_ORDER) {
          const p = room.seats[seat].participant
          if (
            p?.kind === 'human' &&
            p.identity.profileId === session.profile.profileId &&
            p.identity.avatarUrl !== avatarUrl
          ) {
            const updatedParticipant = {
              ...p,
              identity: { ...p.identity, avatarUrl },
              publicProfile: p.publicProfile
                ? { ...p.publicProfile, avatarUrl }
                : p.publicProfile,
            }
            const nextRoom = updateHumanParticipantInRoom(room, seat, updatedParticipant)
            serverState = commitServerRoomWithSnapshot(nextRoom)
            broadcastRoomSnapshots(nextRoom, socketRegistry)
            break
          }
        }
      }
    }

    sendJsonResponse(res, 200, {
      ok: true,
      session: withPikaTeamGiftBypassFlag({
        ...session,
        profile: result.profile,
      }),
    })
    return true
  }

  if (pathname === '/api/profile/me/display-name') {
    const priceAmount = adminSettingsStore.getSettings().profileNameChangePrice
    const result = playerProgressStore.changeProfileDisplayName(
      session.profile.profileId,
      getStringField(body, 'displayName'),
      priceAmount,
    )

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      session: withPikaTeamGiftBypassFlag({
        ...session,
        profile: result.profile,
      }),
    })
    return true
  }

  if (pathname === '/api/profile/me/gallery') {
    const existingProfile = playerProgressStore.getPublicProfile(
      session.profile.profileId,
    )

    if (
      existingProfile !== null &&
      existingProfile.galleryImages.length >= MAX_PROFILE_GALLERY_IMAGES
    ) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: `Галерията може да има най-много ${MAX_PROFILE_GALLERY_IMAGES} снимки.`,
      })
      return true
    }

    const imageBuffer = decodeImageDataUrl(getStringField(body, 'imageDataUrl'))

    if (imageBuffer === null) {
      logProfileImageUploadFailure({
        flow: 'gallery',
        stage: 'decode_request',
        inputBytes: 0,
        errorCode: 'invalid_payload',
      })
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Изпрати валидна снимка до 5 MB.',
      })
      return true
    }

    const galleryResult = await createGalleryImageWebp(imageBuffer)

    if (!galleryResult.ok) {
      logProfileImageUploadFailure({
        flow: 'gallery',
        stage: 'process_image',
        inputBytes: imageBuffer.length,
        errorCode: galleryResult.error,
        detectedFormat: galleryResult.detectedFormat,
      })
      sendJsonResponse(res, 400, {
        ok: false,
        code: galleryResult.error,
        message: getProfileImageProcessingMessage(galleryResult.error),
      })
      return true
    }

    const imageId = randomUUID()
    const profileGalleryPath = join(
      GALLERY_UPLOADS_PATH,
      session.profile.profileId,
    )

    await writeWebpUploadFile(profileGalleryPath, `${imageId}.webp`, galleryResult.buffer)

    const imageUrl = createUploadUrl(
      'profile-gallery',
      session.profile.profileId,
      `${imageId}.webp`,
    )
    const result = playerProgressStore.addProfileGalleryImage({
      profileId: session.profile.profileId,
      imageId,
      imageUrl,
      thumbnailUrl: imageUrl,
    })

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      session: withPikaTeamGiftBypassFlag({
        ...session,
        profile: result.profile,
      }),
    })
    return true
  }

  const avatarUrl = getStringField(body, 'avatarUrl')

  if (
    avatarUrl === null ||
    (!avatarUrl.startsWith('/assets/avatars/male/') &&
      !avatarUrl.startsWith('/assets/avatars/female/'))
  ) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден URL за аватар.' })
    return true
  }

  const result = playerProgressStore.updateProfileAvatar(
    session.profile.profileId,
    avatarUrl,
  )

  if (!result.ok) {
    sendJsonResponse(res, 400, result)
    return true
  }

  sendJsonResponse(res, 200, {
    ok: true,
    session: withPikaTeamGiftBypassFlag({
      ...session,
      profile: result.profile,
    }),
  })
  return true
}

function hasOnlyAllowedFields(
  body: Record<string, unknown>,
  allowedFields: Set<string>,
): boolean {
  return Object.keys(body).every((key) => allowedFields.has(key))
}

async function handleAdminProfileModerationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const displayNameMatch = pathname.match(/^\/api\/admin\/profiles\/([^/]+)\/display-name$/)
  const avatarMatch = pathname.match(/^\/api\/admin\/profiles\/([^/]+)\/avatar$/)
  const galleryDeleteMatch = pathname.match(/^\/api\/admin\/profiles\/([^/]+)\/gallery\/([^/]+)$/)

  if (!displayNameMatch && !avatarMatch && !galleryDeleteMatch) return false

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isFullAdminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Само администратор може да редактира чужд профил.' })
    return true
  }

  const targetProfileId = decodeURIComponent(
    (displayNameMatch?.[1] ?? avatarMatch?.[1] ?? galleryDeleteMatch?.[1] ?? '').trim(),
  )

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(targetProfileId)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден profileId.' })
    return true
  }

  if (session.profile.profileId === targetProfileId) {
    sendJsonResponse(res, 400, { ok: false, message: 'За собствен профил използвай стандартната редакция.' })
    return true
  }

  if (displayNameMatch) {
    if (req.method !== 'PATCH' && req.method !== 'POST') return false
    const body = await readJsonRequestBody(req, MAX_JSON_BODY_BYTES)
    if (!isRecord(body) || !hasOnlyAllowedFields(body, new Set(['displayName']))) {
      sendJsonResponse(res, 400, { ok: false, message: 'Позволена е само промяна на displayName.' })
      return true
    }

    const result = playerProgressStore.adminRenameProfileDisplayName(
      targetProfileId,
      getStringField(body, 'displayName'),
    )

    sendJsonResponse(res, result.ok ? 200 : 400, result)
    return true
  }

  if (avatarMatch) {
    if (req.method !== 'PATCH' && req.method !== 'POST') return false
    const body = await readJsonRequestBody(req, MAX_JSON_BODY_BYTES)
    const allowedAvatarFields = new Set(['avatarUrl', 'imageDataUrl', 'cropX', 'cropY', 'cropSize'])
    if (!isRecord(body) || !hasOnlyAllowedFields(body, allowedAvatarFields)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Позволена е само промяна на avatar.' })
      return true
    }

    if (req.method === 'PATCH') {
      const avatarUrl = getStringField(body, 'avatarUrl')
      if (
        avatarUrl === null ||
        (!avatarUrl.startsWith('/assets/avatars/male/') &&
          !avatarUrl.startsWith('/assets/avatars/female/'))
      ) {
        sendJsonResponse(res, 400, { ok: false, message: 'Невалиден URL за аватар.' })
        return true
      }

      const result = playerProgressStore.updateProfileAvatar(targetProfileId, avatarUrl)
      sendJsonResponse(res, result.ok ? 200 : 400, result)
      return true
    }

    const imageBuffer = decodeImageDataUrl(getStringField(body, 'imageDataUrl'))
    const cropX = getNumberField(body, 'cropX')
    const cropY = getNumberField(body, 'cropY')
    const cropSize = getNumberField(body, 'cropSize')

    if (
      imageBuffer === null ||
      cropX === null ||
      cropY === null ||
      cropSize === null
    ) {
      logProfileImageUploadFailure({
        flow: 'avatar',
        stage: 'admin_decode_request',
        inputBytes: 0,
        errorCode: 'invalid_payload',
      })
      sendJsonResponse(res, 400, { ok: false, message: 'Изпрати валидна снимка и crop за аватар.' })
      return true
    }

    const avatarResult = await createCroppedAvatarWebp({
      imageBuffer,
      cropX,
      cropY,
      cropSize,
    })

    if (!avatarResult.ok) {
      logProfileImageUploadFailure({
        flow: 'avatar',
        stage: 'admin_process_image',
        inputBytes: imageBuffer.length,
        errorCode: avatarResult.error,
        detectedFormat: avatarResult.detectedFormat,
      })
      sendJsonResponse(res, 400, {
        ok: false,
        code: avatarResult.error,
        message: getProfileImageProcessingMessage(avatarResult.error),
      })
      return true
    }

    const avatarFilename = `${randomUUID()}.webp`
    await writeWebpUploadFile(AVATAR_UPLOADS_PATH, avatarFilename, avatarResult.buffer)
    const avatarUrl = createUploadUrl('avatars', avatarFilename)
    const result = playerProgressStore.updateProfileAvatar(targetProfileId, avatarUrl)
    if (!result.ok) {
      void deleteUploadFileByUrl(avatarUrl)
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(res, 200, result)
    return true
  }

  if (galleryDeleteMatch) {
    if (req.method !== 'DELETE') return false
    const imageId = decodeURIComponent(galleryDeleteMatch[2] ?? '').trim()

    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(imageId)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалидна снимка за изтриване.' })
      return true
    }

    const result = playerProgressStore.deleteProfileGalleryImage(targetProfileId, imageId)
    if (!result.ok) {
      sendJsonResponse(res, 404, result)
      return true
    }

    await Promise.all(result.deletedImageUrls.map(deleteUploadFileByUrl))
    sendJsonResponse(res, 200, { ok: true, profile: result.profile })
    return true
  }

  return false
}

/**
 * Управление и справка за субадмин роля:
 *   GET    = текуща роля на целевия профил (за "Субадмин" бадж в профилния
 *            попъп — единственото място, откъдето ролята изтича към клиента,
 *            и то само за пълен admin. НЕ пипаме споделения
 *            PlayerPublicProfileSnapshot conveyor, защото той се сериализира
 *            в ~15 други, не-административни пътища — риск от изтичане на
 *            субадмин статус към обикновени потребители).
 *   POST   = grant, DELETE = revoke.
 * Само пълен admin (isFullAdminSession) за ВСИЧКИ методи — никога субадмин,
 * дори по директна API заявка. Всички self/target-is-admin/no-account/
 * конкурентни защити са в authStore.setSubadminRole (единствен източник на
 * истина за прехода).
 */
async function handleAdminSubadminRoleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = pathname.match(/^\/api\/admin\/profiles\/([^/]+)\/subadmin$/)
  if (!match) return false

  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') return false

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isFullAdminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Само администратор може да управлява роли.' })
    return true
  }

  const targetProfileId = decodeURIComponent((match[1] ?? '').trim())

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(targetProfileId)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден profileId.' })
    return true
  }

  if (req.method === 'GET') {
    const role = authStore.getAccountRoleForProfile(targetProfileId)
    sendJsonResponse(res, 200, { ok: true, role })
    return true
  }

  const result = authStore.setSubadminRole({
    actorAccountId: session.account.accountId,
    targetProfileId,
    action: req.method === 'POST' ? 'grant' : 'revoke',
  })

  if (!result.ok) {
    const statusByCode: Record<typeof result.code, number> = {
      not_found: 404,
      no_account: 400,
      self: 400,
      target_is_admin: 409,
      conflict: 409,
      profile_inactive: 400,
      profile_temporary: 400,
      account_inactive: 400,
    }
    sendJsonResponse(res, statusByCode[result.code], { ok: false, message: result.message })
    return true
  }

  sendJsonResponse(res, 200, { ok: true, role: result.role })
  return true
}

/**
 * Управление на chat_admin роля — огледално на handleAdminSubadminRoleRequest,
 * виж коментара там за пълния rationale. Няма отделен GET тук — четенето на
 * текущата роля на профил (за badge/бутони в попъпа) минава през СЪЩИЯ
 * /api/admin/profiles/:id/subadmin GET (той вече връща произволна роля през
 * authStore.getAccountRoleForProfile, не само subadmin) — не дублираме
 * четящ endpoint само заради различно име на пътя.
 * POST = grant, DELETE = revoke. Само пълен admin (isFullAdminSession).
 */
async function handleAdminChatAdminRoleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = pathname.match(/^\/api\/admin\/profiles\/([^/]+)\/chat-admin$/)
  if (!match) return false

  if (req.method !== 'POST' && req.method !== 'DELETE') return false

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isFullAdminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Само администратор може да управлява роли.' })
    return true
  }

  const targetProfileId = decodeURIComponent((match[1] ?? '').trim())

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(targetProfileId)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден profileId.' })
    return true
  }

  const result = authStore.setChatAdminRole({
    actorAccountId: session.account.accountId,
    targetProfileId,
    action: req.method === 'POST' ? 'grant' : 'revoke',
  })

  if (!result.ok) {
    const statusByCode: Record<typeof result.code, number> = {
      not_found: 404,
      no_account: 400,
      self: 400,
      target_is_admin: 409,
      conflict: 409,
      profile_inactive: 400,
      profile_temporary: 400,
      account_inactive: 400,
    }
    sendJsonResponse(res, statusByCode[result.code], { ok: false, message: result.message })
    return true
  }

  sendJsonResponse(res, 200, { ok: true, role: result.role })
  return true
}

async function handleAdminPikaTeamRoleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = pathname.match(/^\/api\/admin\/profiles\/([^/]+)\/pika-team$/)
  if (!match) return false

  if (req.method !== 'POST' && req.method !== 'DELETE') return false

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isFullAdminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Само администратор може да управлява роли.' })
    return true
  }

  const targetProfileId = decodeURIComponent((match[1] ?? '').trim())

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(targetProfileId)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден profileId.' })
    return true
  }

  const result = authStore.setPikaTeamRole({
    actorAccountId: session.account.accountId,
    targetProfileId,
    action: req.method === 'POST' ? 'grant' : 'revoke',
  })

  if (!result.ok) {
    const statusByCode: Record<typeof result.code, number> = {
      not_found: 404,
      no_account: 400,
      self: 400,
      target_is_admin: 409,
      conflict: 409,
      profile_inactive: 400,
      profile_temporary: 400,
      account_inactive: 400,
    }
    sendJsonResponse(res, statusByCode[result.code], { ok: false, message: result.message })
    return true
  }

  sendJsonResponse(res, 200, { ok: true, role: result.role })
  return true
}

async function handleAdminTopChatAdminRoleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = pathname.match(/^\/api\/admin\/profiles\/([^/]+)\/top-chat-admin$/)
  if (!match) return false

  if (req.method !== 'POST' && req.method !== 'DELETE') return false

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isFullAdminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Само администратор може да управлява роли.' })
    return true
  }

  const targetProfileId = decodeURIComponent((match[1] ?? '').trim())

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(targetProfileId)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден profileId.' })
    return true
  }

  const result = authStore.setTopChatAdminRole({
    actorAccountId: session.account.accountId,
    targetProfileId,
    action: req.method === 'POST' ? 'grant' : 'revoke',
  })

  if (!result.ok) {
    const statusByCode: Record<typeof result.code, number> = {
      not_found: 404,
      no_account: 400,
      self: 400,
      target_is_admin: 409,
      conflict: 409,
      profile_inactive: 400,
      profile_temporary: 400,
      account_inactive: 400,
    }
    sendJsonResponse(res, statusByCode[result.code], { ok: false, message: result.message })
    return true
  }

  sendJsonResponse(res, 200, { ok: true, role: result.role })
  return true
}

/**
 * Само пълен admin (isFullAdminSession — role==='admin' от FRESH session,
 * не frontend-only проверка) може да "подари" VIP дни директно от чужд
 * profile popup. Grant-ва през СЪЩИЯ vipStore.grantVip() authoritative
 * mechanism като launch-gift/purchase (reason='admin_grant',
 * base=max(now, currentActiveUntil) удължаване — виж vipStore.applyGrant),
 * с audit trail в vip_grants.granted_by_profile_id + resulting_active_until.
 * Не създава паралелна VIP система. Връща пълния, прясно enriched профил
 * (не само activeUntil) — клиентът презаписва popup-а веднага без reload
 * (viж updateEditedTargetProfile в createLobbyFlowController.ts).
 */
async function handleAdminVipGrantRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = pathname.match(/^\/api\/admin\/profiles\/([^/]+)\/vip-grant$/)
  if (!match) return false

  if (req.method !== 'POST') return false

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isFullAdminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Само администратор може да дава VIP.' })
    return true
  }

  const targetProfileId = decodeURIComponent((match[1] ?? '').trim())

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(targetProfileId)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден profileId.' })
    return true
  }

  if (session.profile.profileId === targetProfileId) {
    sendJsonResponse(res, 400, { ok: false, message: 'Не можеш да дадеш VIP на себе си оттук.' })
    return true
  }

  if (playerProgressStore.getPublicProfile(targetProfileId) === null) {
    sendJsonResponse(res, 404, { ok: false, message: 'Профилът не беше намерен.' })
    return true
  }

  const body = await readJsonRequestBody(req, MAX_JSON_BODY_BYTES)
  if (!isRecord(body) || !hasOnlyAllowedFields(body, new Set(['days']))) {
    sendJsonResponse(res, 400, { ok: false, message: 'Позволено е само поле days.' })
    return true
  }

  const days = getNumberField(body, 'days')
  if (days === null || !Number.isInteger(days) || days <= 0) {
    sendJsonResponse(res, 400, { ok: false, message: 'Броят дни трябва да е цяло положително число.' })
    return true
  }

  vipStore.grantVip(targetProfileId, 'admin_grant', { unit: 'days', amount: days }, session.profile.profileId)

  const updatedProfile = playerProgressStore.getPublicProfile(targetProfileId)
  if (updatedProfile === null) {
    sendJsonResponse(res, 404, { ok: false, message: 'Профилът не беше намерен след grant-а.' })
    return true
  }

  const [enrichedProfile] = enrichPlayerProfilesForViewer([updatedProfile], session.profile.profileId)

  sendJsonResponse(res, 200, { ok: true, profile: enrichedProfile })
  return true
}

async function handleProfileBlockRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const blockMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/block$/)
  const isBlocksList = pathname === '/api/blocks'

  if (!blockMatch && !isBlocksList) return false

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null || session.profile.profileId === null) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }

  const myProfileId = session.profile.profileId

  if (isBlocksList && req.method === 'GET') {
    const profileIds = blockStore.getBlockedProfileIds(myProfileId)
    const profiles = profileIds.flatMap((id) => {
      const p = playerProgressStore.getPublicProfile(id)
      return p ? [p] : []
    })
    sendJsonResponse(res, 200, {
      ok: true,
      profiles,
      count: profiles.length,
      limit: BLOCK_LIMIT,
    })
    return true
  }

  if (blockMatch && req.method === 'POST') {
    const targetProfileId = decodeURIComponent(blockMatch[1])

    if (myProfileId === targetProfileId) {
      sendJsonResponse(res, 400, { ok: false, message: 'Не можеш да блокираш себе си.' })
      return true
    }

    if (playerProgressStore.isTemporaryProfile(targetProfileId)) {
      sendJsonResponse(res, 200, { ok: true, blocked: false })
      return true
    }

    const result = blockStore.toggleBlock(myProfileId, targetProfileId)
    invalidateLobbyChatBlockCache(myProfileId)

    if (result.limitReached) {
      sendJsonResponse(res, 429, {
        ok: false,
        limitReached: true,
        message: `Достигнахте лимита от ${BLOCK_LIMIT} блокирани играча. Освободете място, за да блокирате нов.`,
      })
      return true
    }

    if (!result.blocked) {
      topicReadStateStore.markSenderSeenThroughCurrent(myProfileId, targetProfileId)
      broadcastTopicUnreadCountsToProfile(myProfileId)
    }

    sendJsonResponse(res, 200, { ok: true, blocked: result.blocked })
    return true
  }

  return false
}

async function handleProfileLikeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = pathname.match(/^\/api\/profiles\/([^/]+)\/like$/)
  if (!match || req.method !== 'POST') return false

  const likedProfileId = decodeURIComponent(match[1])
  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)
  if (!session) {
    sendJsonResponse(res, 401, { ok: false, message: 'Не си влязъл.' })
    return true
  }

  const likerProfileId = session.profile.profileId
  if (!likerProfileId) {
    sendJsonResponse(res, 401, { ok: false, message: 'Не си влязъл.' })
    return true
  }
  if (likerProfileId === likedProfileId) {
    sendJsonResponse(res, 400, { ok: false, message: 'Не може да харесаш себе си.' })
    return true
  }

  const result = likeStore.addLike(likerProfileId, likedProfileId)
  if (!result.ok) {
    sendJsonResponse(res, 429, { ok: false, message: 'Вече харесано. Опитай след 4 часа.' })
    return true
  }

  const likerProfile = playerProgressStore.getPublicProfile(likerProfileId)
  if (likerProfile) {
    sendToOpenProfileConnections(likedProfileId, {
      type: 'profile_liked',
      fromProfileId: likerProfileId,
      fromDisplayName: likerProfile.displayName,
      fromAvatarUrl: likerProfile.avatarUrl,
    })
  }

  sendJsonResponse(res, 200, { ok: true, liked: true, likesCount: result.likesCount })
  return true
}

const PLAYERS_PAGE_SIZE = 300

async function handlePlayersRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  requestUrl: URL,
): Promise<boolean> {
  if (pathname !== '/api/players' || req.method !== 'GET') {
    return false
  }

  const onlineProfileIds = new Set<string>()
  for (const conn of Object.values(serverState.connections)) {
    if (conn.profileId && socketRegistry.get(conn.id)?.readyState === WebSocket.OPEN) {
      onlineProfileIds.add(conn.profileId)
    }
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)
  const currentProfileId = session?.profile.profileId ?? null
  const isAdmin = isAdminOrSubadminSession(session)

  const rawPage = parseStrictQueryInt(requestUrl.searchParams.get('page'))
  const requestedPage = rawPage === 'invalid' || rawPage === null ? 1 : rawPage

  const incomingSnapshotToken = requestUrl.searchParams.get('snapshot')
  const existingOrder = incomingSnapshotToken
    ? playersPageSnapshotStore.get(incomingSnapshotToken, isAdmin, currentProfileId)
    : null

  let orderedIds: string[]
  let snapshotToken: string
  let effectivePage: number
  // true само ако клиентът Е подал token, но той се оказа невалиден/
  // изтекъл/за друг viewer — НЕ и при обикновено прясно отваряне (без token).
  const snapshotReset = incomingSnapshotToken !== null && existingOrder === null

  if (existingOrder !== null && incomingSnapshotToken) {
    // Валиден, все още жив snapshot — преизползваме замразената подредба
    // непроменена (isOnline статусът на картите пак се смята "на живо" по-долу).
    orderedIds = existingOrder
    snapshotToken = incomingSnapshotToken
    effectivePage = requestedPage
  } else {
    // Липсващ/невалиден/изтекъл/чужд snapshot ИЛИ прясно отваряне →
    // изчисляваме и замразяваме НОВА глобална подредба; винаги страница 1
    // (никога не се доверяваме на исканата страница под непознат snapshot).
    const eligible = playerProgressStore.listEligibleProfileKinds()
    orderedIds = computePlayersPageOrder(eligible, {
      isAdmin,
      onlineProfileIds,
      seed: generatePlayersPageSeed(),
      ownProfileId: currentProfileId,
    })
    snapshotToken = playersPageSnapshotStore.create(orderedIds, isAdmin, currentProfileId)
    effectivePage = 1
  }

  const totalCount = orderedIds.length
  const totalPages = Math.max(1, Math.ceil(totalCount / PLAYERS_PAGE_SIZE))
  const page = Math.min(Math.max(1, effectivePage), totalPages)

  const pageIds = orderedIds.slice((page - 1) * PLAYERS_PAGE_SIZE, page * PLAYERS_PAGE_SIZE)
  const pageSnapshots = playerProgressStore.getProfileSnapshotsByIds(pageIds, onlineProfileIds)
  const players = enrichPlayerProfilesForViewer(pageSnapshots, currentProfileId)

  sendJsonResponse(res, 200, {
    ok: true,
    players,
    page,
    pageSize: PLAYERS_PAGE_SIZE,
    totalCount,
    totalPages,
    snapshot: snapshotToken,
    snapshotReset,
  })
  return true
}

const PLAYERS_SEARCH_MIN_QUERY_LENGTH = 2
const PLAYERS_SEARCH_MAX_RAW_QUERY_LENGTH = 64
const PLAYERS_SEARCH_TOO_SHORT_MESSAGE = 'Въведи поне 2 символа за търсене.'

function enrichPlayerProfilesForViewer(
  profiles: PlayerPublicProfileSnapshot[],
  currentProfileId: string | null,
): PlayerPublicProfileSnapshot[] {
  return profiles.map((p) => {
    // Един vipStore.getStatus() извикване за isVip И vipActiveUntil — вместо
    // отделна VIP HTTP заявка при отваряне на чужд профил, expiration-ът се
    // включва директно в profile payload-а (players directory, search,
    // /api/profiles/:id — всички минават през тази shared enrichment).
    const vipStatus = p.profileId ? vipStore.getStatus(p.profileId) : null
    return {
      ...p,
      likesCount: p.profileId ? likeStore.getLikesCount(p.profileId) : null,
      hasLikedByMe: p.profileId && currentProfileId
        ? likeStore.hasLikedRecently(currentProfileId, p.profileId)
        : null,
      isBlockedByMe: p.profileId && currentProfileId
        ? blockStore.isBlocked(currentProfileId, p.profileId)
        : null,
      isVip: vipStatus?.isActive ?? null,
      vipActiveUntil: vipStatus?.activeUntil ?? null,
    }
  })
}

// Canonical single-profile lookup by id — reuse-ва playerProgressStore
// (единствения source of truth за public profile данни) и
// enrichPlayerProfilesForViewer (същия likes/blocked/VIP enrichment, ползван
// от players directory/leaderboards). Достъпен за всеки логнат потребител —
// profile popup-ът (напр. от "Теми") трябва да покаже актуални данни за
// произволен профил, не само за тези вече в state.players кеша на клиента.
type ProfileAccessDenial =
  | { ok: false; code: 'profile_blocked_by_viewer'; message: string }
  | { ok: false; code: 'profile_blocked_viewer'; message: string }

function getProfileAccessDenial(
  viewerProfileId: string | null,
  targetProfileId: string | null,
): ProfileAccessDenial | null {
  if (
    viewerProfileId === null ||
    targetProfileId === null ||
    viewerProfileId === targetProfileId
  ) {
    return null
  }

  if (blockStore.isBlocked(viewerProfileId, targetProfileId)) {
    return {
      ok: false,
      code: 'profile_blocked_by_viewer',
      message: 'Този потребител е блокиран от Вас.',
    }
  }

  if (blockStore.isBlocked(targetProfileId, viewerProfileId)) {
    return {
      ok: false,
      code: 'profile_blocked_viewer',
      message: 'Този потребител ви е блокирал.',
    }
  }

  return null
}

async function handleProfileByIdRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/profiles\/([^/]+)$/.exec(pathname)
  if (!match || req.method !== 'GET') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)
  const currentProfileId = session?.profile.profileId ?? null

  const profileId = decodeURIComponent(match[1] ?? '')
  const profile = playerProgressStore.getPublicProfile(profileId)

  if (profile === null) {
    sendJsonResponse(res, 404, {
      ok: false,
      message: 'Профилът не беше намерен.',
    })
    return true
  }

  const accessDenial = getProfileAccessDenial(currentProfileId, profileId)

  if (accessDenial !== null) {
    sendJsonResponse(res, 403, accessDenial)
    return true
  }

  const [enriched] = enrichPlayerProfilesForViewer([profile], currentProfileId)

  sendJsonResponse(res, 200, {
    ok: true,
    profile: enriched,
  })
  return true
}

async function handlePlayersSearchRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  requestUrl: URL,
): Promise<boolean> {
  // Точен match — /api/players/search не трябва да бъде прихванат от,
  // нито да прихваща, евентуален бъдещ динамичен /api/players/:id маршрут.
  if (pathname !== '/api/players/search' || req.method !== 'GET') {
    return false
  }

  const rawQuery = (requestUrl.searchParams.get('q') ?? '').trim()

  if (rawQuery.length === 0) {
    sendJsonResponse(res, 400, { ok: false, message: PLAYERS_SEARCH_TOO_SHORT_MESSAGE })
    return true
  }

  if (rawQuery.length > PLAYERS_SEARCH_MAX_RAW_QUERY_LENGTH) {
    sendJsonResponse(res, 400, { ok: false, message: 'Търсенето е твърде дълго.' })
    return true
  }

  const normalizedTerm = normalizeProfileSearchTerm(rawQuery)

  if (normalizedTerm.length < PLAYERS_SEARCH_MIN_QUERY_LENGTH) {
    sendJsonResponse(res, 400, { ok: false, message: PLAYERS_SEARCH_TOO_SHORT_MESSAGE })
    return true
  }

  // Идентична идентификация на текущия потребител и на онлайн профилите
  // като в handlePlayersRequest — search резултатите носят същите
  // isOnline/likesCount/hasLikedByMe/isBlockedByMe правила за достъп.
  const onlineProfileIds = new Set<string>()
  for (const conn of Object.values(serverState.connections)) {
    if (conn.profileId && socketRegistry.get(conn.id)?.readyState === WebSocket.OPEN) {
      onlineProfileIds.add(conn.profileId)
    }
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)
  const currentProfileId = session?.profile.profileId ?? null

  // LIMIT-ът е твърдо зададен в searchPublicProfilesStatement (50) —
  // клиентът няма начин да го надвиши, тъй като не се чете никакъв
  // limit/offset query параметър тук.
  const matches = playerProgressStore.searchPublicProfiles(normalizedTerm, onlineProfileIds)
  const players = enrichPlayerProfilesForViewer(matches, currentProfileId)

  sendJsonResponse(res, 200, { ok: true, players })
  return true
}

function markMatchmakingEntriesStakePaid(entryIds: string[]): void {
  const entryIdsSet = new Set(entryIds)

  matchmakingState = {
    ...matchmakingState,
    queueEntries: matchmakingState.queueEntries.map((entry) =>
      entryIdsSet.has(entry.entryId)
        ? {
            ...entry,
            stakePaid: true,
          }
        : entry,
    ),
  }
}

function collectReadyMatchmakingStakes(stake: MatchStake): void {
  let searchingEntries = getSearchingEntriesByStake(
    matchmakingState.queueEntries,
    stake,
  ).sort((a, b) => a.joinedAt - b.joinedAt)

  if (searchingEntries.length < 2) {
    return
  }

  for (const entry of searchingEntries) {
    if (entry.stakePaid) {
      continue
    }

    if (
      entry.profileId === null ||
      !matchEconomyStore.hasEnoughBalance(entry.profileId, entry.stake)
    ) {
      matchmakingState = {
        ...matchmakingState,
        queueEntries: removeQueueEntryByConnectionId(
          matchmakingState.queueEntries,
          entry.connectionId,
        ),
      }
      safeSendToConnection(entry.connectionId, {
        type: 'error',
        message: 'Нямаш достатъчно жълтици за този залог.',
      })
    }
  }

  searchingEntries = getSearchingEntriesByStake(
    matchmakingState.queueEntries,
    stake,
  ).sort((a, b) => a.joinedAt - b.joinedAt)

  if (searchingEntries.length < 2) {
    broadcastMatchmakingStatusForStake(stake)
    return
  }

  const paidEntryIds: string[] = []
  const justPaidConnectionIds = new Set<ConnectionId>()

  for (const entry of searchingEntries) {
    if (entry.stakePaid || entry.profileId === null) {
      continue
    }

    const result = matchEconomyStore.collectQueueStake(
      entry.entryId,
      entry.profileId,
      entry.stake,
    )

    if (!result.ok) {
      matchmakingState = {
        ...matchmakingState,
        queueEntries: removeQueueEntryByConnectionId(
          matchmakingState.queueEntries,
          entry.connectionId,
        ),
      }
      safeSendToConnection(entry.connectionId, {
        type: 'error',
        message: result.message,
      })
      continue
    }

    paidEntryIds.push(entry.entryId)
    justPaidConnectionIds.add(entry.connectionId)
  }

  if (paidEntryIds.length > 0) {
    markMatchmakingEntriesStakePaid(paidEntryIds)
  }

  const finalEntries = getSearchingEntriesByStake(matchmakingState.queueEntries, stake)
  for (const entry of finalEntries) {
    sendMatchmakingStatusToConnection(
      entry.connectionId,
      stake,
      justPaidConnectionIds.has(entry.connectionId) ? true : undefined,
    )
  }
}

async function handleLeaderboardsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/leaderboards' || req.method !== 'GET') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)
  const currentProfileId = session?.profile.profileId ?? null

  const rawLeaderboards = playerProgressStore.listLeaderboards()
  const enrichLeaderboard = (profiles: typeof rawLeaderboards[keyof typeof rawLeaderboards]) =>
    profiles.map((p) => ({
      ...p,
      likesCount: p.profileId ? likeStore.getLikesCount(p.profileId) : null,
      hasLikedByMe: p.profileId && currentProfileId
        ? likeStore.hasLikedRecently(currentProfileId, p.profileId)
        : null,
      isBlockedByMe: p.profileId && currentProfileId
        ? blockStore.isBlocked(currentProfileId, p.profileId)
        : null,
      isVip: p.profileId ? vipStore.getStatus(p.profileId).isActive : null,
    }))

  sendJsonResponse(res, 200, {
    ok: true,
    leaderboards: Object.fromEntries(
      Object.entries(rawLeaderboards).map(([key, val]) => [key, enrichLeaderboard(val)])
    ),
  })
  return true
}

async function handlePublicSettingsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/settings/public' || req.method !== 'GET') {
    return false
  }

  const settings = adminSettingsStore.getSettings()

  const onlineProfileIds = new Set<string>()
  for (const conn of Object.values(serverState.connections)) {
    if (conn.profileId && socketRegistry.get(conn.id)?.readyState === WebSocket.OPEN) {
      onlineProfileIds.add(conn.profileId)
    }
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)
  if (session?.profile.profileId) {
    onlineProfileIds.add(session.profile.profileId)
  }

  const allProfiles = playerProgressStore.listPublicHumanProfiles(onlineProfileIds)
  const onlinePlayersCount = allProfiles.filter((p) => p.isOnline).length

  sendJsonResponse(res, 200, {
    ok: true,
    onlinePlayersCount,
    settings: {
      signupBonusYellowCoins: settings.signupBonusYellowCoins,
      profileNameChangePrice: settings.profileNameChangePrice,
    },
  })
  return true
}

async function handleShopPackagesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/shop/packages' || req.method !== 'GET') {
    return false
  }

  sendJsonResponse(res, 200, {
    ok: true,
    packages: coinPackageStore.listPublicPackages(),
  })
  return true
}

async function handleLobbyPackagesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/lobby/packages' || req.method !== 'GET') {
    return false
  }

  sendJsonResponse(res, 200, {
    ok: true,
    packages: coinPackageStore.listLobbyPackages(),
  })
  return true
}

async function handleShopPurchasesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/shop/purchases') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null || session.profile.profileId === null) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си, за да купуваш жълтици.',
    })
    return true
  }

  if (req.method === 'GET') {
    sendJsonResponse(res, 200, {
      ok: true,
      purchases: coinPurchaseStore.listProfilePurchases(session.profile.profileId),
    })
    return true
  }

  if (req.method === 'POST') {
    const body = await readJsonRequestBody(req)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Invalid request body.',
      })
      return true
    }

    const result = coinPurchaseStore.createPendingPurchase(
      session.profile.profileId,
      getStringField(body, 'packageId'),
    )

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      purchase: result.purchase,
      purchases: coinPurchaseStore.listProfilePurchases(session.profile.profileId),
      message:
        'Покупката е записана като pending. Stripe checkout ще бъде свързан в следващата стъпка.',
    })
    return true
  }

  return false
}

async function handleShopCheckoutRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/shop/checkout' || req.method !== 'POST') {
    return false
  }

  // Auth+validation guard-овете вървят ПРЕДИ Stripe-configuration проверката
  // (обратен ред спрямо по-стар код) — неавтентикиран/невалиден request не
  // трябва да разкрива дали Stripe изобщо е конфигуриран на сървъра, а и
  // позволява 401/400 да се тестват детерминистично без нужда от реален
  // STRIPE_SECRET_KEY в тестова среда.
  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null || session.profile.profileId === null) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си, за да купуваш жълтици.',
    })
    return true
  }

  const body = await readJsonRequestBody(req)

  if (!isRecord(body)) {
    sendJsonResponse(res, 400, {
      ok: false,
      message: 'Invalid request body.',
    })
    return true
  }

  const packageId = getStringField(body, 'packageId')

  const pendingResult = coinPurchaseStore.createPendingPurchase(
    session.profile.profileId,
    packageId,
  )

  if (!pendingResult.ok) {
    sendJsonResponse(res, 400, pendingResult)
    return true
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY

  if (!stripeSecretKey) {
    sendJsonResponse(res, 500, {
      ok: false,
      message: 'Stripe не е конфигуриран на сървъра. Моля, свържи се с администратор.',
    })
    return true
  }

  const { purchase } = pendingResult

  const clientOrigin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173'
  const successUrl =
    process.env.STRIPE_SUCCESS_URL ??
    `${clientOrigin}/lobby?payment=success&session_id={CHECKOUT_SESSION_ID}`
  const cancelUrl =
    process.env.STRIPE_CANCEL_URL ?? `${clientOrigin}/lobby?payment=cancel`

  const stripe = new Stripe(stripeSecretKey)

  let checkoutSession: Stripe.Checkout.Session

  try {
    checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: [
        {
          price_data: {
            currency: purchase.currency.toLowerCase(),
            unit_amount: purchase.priceCents,
            product_data: {
              name: purchase.title,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        purchaseId: purchase.purchaseId,
        profileId: session.profile.profileId,
        packageId: purchase.packageId ?? '',
        packageKey: purchase.packageKey,
        coins: String(purchase.yellowCoinsAmount),
      },
    })
  } catch (error) {
    sendJsonResponse(res, 500, {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : 'Stripe checkout не беше стартиран.',
    })
    return true
  }

  const attached = coinPurchaseStore.attachCheckoutSession(
    purchase.purchaseId,
    checkoutSession.id,
  )

  if (attached === null) {
    sendJsonResponse(res, 500, {
      ok: false,
      message: 'Checkout сесията не беше записана към покупката.',
    })
    return true
  }

  sendJsonResponse(res, 200, {
    ok: true,
    checkoutUrl: checkoutSession.url,
    checkoutSessionId: checkoutSession.id,
    purchase: attached,
  })

  return true
}

// ─── VIP оферти: каталог + checkout ────────────────────────────────────────

// Mirror на handleShopPurchasesRequest GET клона (coins) — client-side
// "wait for paid" polling след Stripe redirect се нуждае от начин да прочете
// providerCheckoutSessionId/status за собствените VIP покупки (webhook е
// source of truth, success redirect URL сам по себе си не е достатъчен).
async function handleVipPurchasesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/vip/purchases' || req.method !== 'GET') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null || session.profile.profileId === null) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си.',
    })
    return true
  }

  sendJsonResponse(res, 200, {
    ok: true,
    purchases: vipPurchaseStore.listProfilePurchases(session.profile.profileId),
  })
  return true
}

async function handleVipPackagesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/vip/packages' || req.method !== 'GET') {
    return false
  }

  const settings = adminSettingsStore.getSettings()

  sendJsonResponse(res, 200, {
    ok: true,
    packages: [
      {
        packageId: 'vip_30' as VipPackageId,
        title: VIP_PACKAGE_CATALOG.vip_30.title,
        days: VIP_PACKAGE_CATALOG.vip_30.days,
        priceCents: settings.vipPrice30DaysCents,
        currency: 'EUR',
      },
      {
        packageId: 'vip_180' as VipPackageId,
        title: VIP_PACKAGE_CATALOG.vip_180.title,
        days: VIP_PACKAGE_CATALOG.vip_180.days,
        priceCents: settings.vipPrice180DaysCents,
        currency: 'EUR',
      },
      {
        packageId: 'vip_365' as VipPackageId,
        title: VIP_PACKAGE_CATALOG.vip_365.title,
        days: VIP_PACKAGE_CATALOG.vip_365.days,
        priceCents: settings.vipPrice365DaysCents,
        currency: 'EUR',
      },
    ],
  })

  return true
}

function getVipPackagePriceCents(packageId: VipPackageId): number {
  const settings = adminSettingsStore.getSettings()
  if (packageId === 'vip_30') return settings.vipPrice30DaysCents
  if (packageId === 'vip_180') return settings.vipPrice180DaysCents
  return settings.vipPrice365DaysCents
}

async function handleVipCheckoutRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/vip/checkout' || req.method !== 'POST') {
    return false
  }

  // Auth+validation guard-овете вървят ПРЕДИ Stripe-configuration проверката
  // (виж identичния коментар в handleShopCheckoutRequest по-горе) — 401/400
  // трябва да са детерминистично testable без нужда от реален
  // STRIPE_SECRET_KEY, а и неавтентикиран caller не научава дали Stripe е
  // конфигуриран.
  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null || session.profile.profileId === null) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си, за да купиш VIP.',
    })
    return true
  }

  const body = await readJsonRequestBody(req)

  if (!isRecord(body)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Invalid request body.' })
    return true
  }

  // Клиентът праща САМО package identifier — сървърът map-ва дни+цена сам
  // (VIP брифа §5). custom EUR amount/days от клиента се игнорира изцяло.
  const packageId = getStringField(body, 'packageId')

  if (packageId === null || !isVipPackageId(packageId)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден VIP пакет.' })
    return true
  }

  const priceCents = getVipPackagePriceCents(packageId)

  const pendingResult = vipPurchaseStore.createPendingPurchase(
    session.profile.profileId,
    packageId,
    priceCents,
  )

  if (!pendingResult.ok) {
    sendJsonResponse(res, 400, pendingResult)
    return true
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY

  if (!stripeSecretKey) {
    sendJsonResponse(res, 500, {
      ok: false,
      message: 'Stripe не е конфигуриран на сървъра. Моля, свържи се с администратор.',
    })
    return true
  }

  const { purchase } = pendingResult

  const clientOrigin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173'
  const successUrl =
    process.env.STRIPE_SUCCESS_URL ??
    `${clientOrigin}/lobby?payment=success&session_id={CHECKOUT_SESSION_ID}`
  const cancelUrl =
    process.env.STRIPE_CANCEL_URL ?? `${clientOrigin}/lobby?payment=cancel`

  const stripe = new Stripe(stripeSecretKey)

  let checkoutSession: Stripe.Checkout.Session

  try {
    checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: [
        {
          price_data: {
            currency: purchase.currency.toLowerCase(),
            unit_amount: purchase.priceCents,
            product_data: {
              name: VIP_PACKAGE_CATALOG[purchase.packageId].title,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        purchaseType: 'vip',
        purchaseId: purchase.purchaseId,
        profileId: session.profile.profileId,
        packageId: purchase.packageId,
      },
    })
  } catch (error) {
    sendJsonResponse(res, 500, {
      ok: false,
      message:
        error instanceof Error ? error.message : 'Stripe checkout не беше стартиран.',
    })
    return true
  }

  const attached = vipPurchaseStore.attachCheckoutSession(
    purchase.purchaseId,
    checkoutSession.id,
  )

  if (attached === null) {
    sendJsonResponse(res, 500, {
      ok: false,
      message: 'Checkout сесията не беше записана към покупката.',
    })
    return true
  }

  sendJsonResponse(res, 200, {
    ok: true,
    checkoutUrl: checkoutSession.url,
    checkoutSessionId: checkoutSession.id,
    purchase: attached,
  })

  return true
}

// ─── VIP: launch gift + status ─────────────────────────────────────────────

const VIP_LAUNCH_GIFT_INTERVAL: VipInterval = { unit: 'days', amount: 30 }

async function handleVipStatusRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/vip/status' || req.method !== 'GET') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null || session.profile.profileId === null) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си.',
    })
    return true
  }

  const status = vipStore.getStatus(session.profile.profileId)

  sendJsonResponse(res, 200, {
    ok: true,
    status,
    hasClaimedLaunchGift: vipStore.hasClaimedLaunchGift(session.profile.profileId),
  })
  return true
}

async function handleVipClaimLaunchGiftRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/vip/claim-launch-gift' || req.method !== 'POST') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null || session.profile.profileId === null) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си, за да вземеш безплатния VIP.',
    })
    return true
  }

  const result = vipStore.claimLaunchGift(session.profile.profileId, VIP_LAUNCH_GIFT_INTERVAL)

  if (!result.ok) {
    sendJsonResponse(res, 409, {
      ok: false,
      code: result.code,
      message: 'Безплатният VIP подарък вече е използван за този профил.',
      status: result.status,
    })
    return true
  }

  sendJsonResponse(res, 200, {
    ok: true,
    status: result.status,
  })
  return true
}

// ─── Topics (Теми): read-only списък + cursor/seq history ──────────────────
// Етап 1 — само четене. Няма send/like/create/moderation handlers тук; те
// идват в следващи етапи.
//
// Достъп: РЕГИСТРИРАН профил (не гост) — валидирано server-side тук, не само
// скрито от навигацията на клиента. Причина: безплатният 30-дневен VIP е
// profile-bound (виж vipStore.ts / launch gift claim), а гост няма profile,
// към който да бъде активиран — затова "Теми" изобщо не се отварят за гост,
// дори само за четене. VIP НЕ се изисква за четене (само за писане, Етап 2).
function requireRegisteredProfileSession(
  req: IncomingMessage,
): { ok: true; profileId: string } | { ok: false } {
  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)
  if (session === null || session.profile.profileId === null) {
    return { ok: false }
  }
  return { ok: true, profileId: session.profile.profileId }
}

const TOPIC_MESSAGES_DEFAULT_LIMIT = 30
const TOPIC_MESSAGES_MAX_LIMIT = 50

// Reuse на СЪЩИЯ decode→validate→process→write pipeline като
// createSupportAttachmentUpload (index.ts, chat/support attachment слоя) —
// enforceSourcePixelLimit:true (decompression-bomb guard), точно като
// support (по-строгия от двата established варианта, виж проучването за
// friend-chat pipeline-a). Извикано от WS handler-а (send_topic_message/
// send_topic_reply), не HTTP — imageDataUrl пътува в WS message payload-а,
// не multipart/form-data.
type TopicAttachmentUploadResult =
  | {
      ok: true
      attachmentInput: {
        storageFilename: string
        width: number
        height: number
        byteSize: number
        contentType: string
      } | null
      writtenAttachmentFilename: string | null
    }
  | { ok: false; code: TopicMessageErrorCode; message: string }

async function createTopicAttachmentUpload(
  imageDataUrlField: unknown,
): Promise<TopicAttachmentUploadResult> {
  if (imageDataUrlField === undefined || imageDataUrlField === null) {
    return { ok: true, attachmentInput: null, writtenAttachmentFilename: null }
  }

  if (typeof imageDataUrlField !== 'string' || imageDataUrlField.trim().length === 0) {
    return { ok: false, code: 'invalid_image', message: 'Невалидна снимка.' }
  }

  const imageBuffer = decodeImageAttachmentDataUrl(imageDataUrlField)

  if (imageBuffer === null) {
    return { ok: false, code: 'invalid_image', message: 'Поддържат се само JPEG, PNG и WebP снимки до 10 MB.' }
  }

  const processed = await processImageAttachmentToWebp(imageBuffer, { enforceSourcePixelLimit: true })

  if (processed === null) {
    return { ok: false, code: 'invalid_image', message: 'Снимката не може да бъде обработена.' }
  }

  const storageFilename = `${randomUUID()}.webp`

  try {
    await writeWebpAttachmentFile(TOPIC_ATTACHMENT_UPLOADS_PATH, storageFilename, processed.buffer)
  } catch {
    return { ok: false, code: 'attachment_upload_failed', message: 'Снимката не можа да бъде записана.' }
  }

  return {
    ok: true,
    writtenAttachmentFilename: storageFilename,
    attachmentInput: {
      storageFilename,
      width: processed.width,
      height: processed.height,
      byteSize: processed.buffer.length,
      contentType: 'image/webp',
    },
  }
}

async function handleTopicsListRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/topics' || req.method !== 'GET') {
    return false
  }

  activityCounters.incrementTopics('topicListRequests')

  const auth = requireRegisteredProfileSession(req)
  if (!auth.ok) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си, за да разгледаш „Теми“.',
    })
    return true
  }

  const topics = topicsWithUnreadCountsForProfile(auth.profileId, topicStore.listActiveTopics())

  // Current-viewer own section-wide mute snapshot (regression fix — composer
  // mute-lock брифа §6) — при вход/refresh на "Теми" НЯМА друг proactive
  // канал за собствения статус на viewer-а (само realtime topic_mute_state_changed
  // push, докато е вече свързан, виж showTopicsDirectory/loadTopicsDirectory
  // коментара в createLobbyFlowController.ts). Reuse на СЪЩАТА
  // getSectionMuteSnapshot функция, ползвана и от enforcement/lazy-lookup
  // пътищата другаде — не нов mute mechanism. Explicit strip на
  // mutedByAccountId (moderator identity), mirror на notifyProfileOfTopicMuteStateChange
  // private push shape-а — never expose-ва се, дори на самия muted профил.
  const viewerSectionMuteSnapshot = topicModerationStore.getSectionMuteSnapshot(auth.profileId)

  sendJsonResponse(res, 200, {
    ok: true,
    topics,
    viewerSectionMute: {
      isMuted: viewerSectionMuteSnapshot.isMuted,
      mutedUntil: viewerSectionMuteSnapshot.mutedUntil,
      reason: viewerSectionMuteSnapshot.reason,
    },
  })
  return true
}

async function handleTopicSeenRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/topics\/([^/]+)\/seen$/.exec(pathname)
  if (!match || req.method !== 'POST') {
    return false
  }

  const auth = requireRegisteredProfileSession(req)
  if (!auth.ok) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си, за да маркираш темата като видяна.',
    })
    return true
  }

  if (playerProgressStore.isTemporaryProfile(auth.profileId)) {
    sendJsonResponse(res, 403, {
      ok: false,
      message: '„Теми“ са само за регистрирани потребители.',
    })
    return true
  }

  const topicId = decodeURIComponent(match[1] ?? '')
  const result = topicReadStateStore.markTopicSeenToLatestSeq(auth.profileId, topicId)
  if (!result.ok) {
    sendJsonResponse(res, 404, {
      ok: false,
      message: 'Темата не беше намерена.',
    })
    return true
  }

  broadcastTopicSeenUpdatedToProfile(auth.profileId, topicId, result.state.lastSeenSeq)
  sendJsonResponse(res, 200, {
    ok: true,
    topicId,
    lastSeenSeq: result.state.lastSeenSeq,
    unreadCount: 0,
  })
  return true
}

async function handleTopicThreadSeenRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/topics\/([^/]+)\/messages\/([^/]+)\/seen$/.exec(pathname)
  if (!match || req.method !== 'POST') {
    return false
  }

  const auth = requireRegisteredProfileSession(req)
  if (!auth.ok) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си, за да маркираш разговора като прочетен.',
    })
    return true
  }

  if (playerProgressStore.isTemporaryProfile(auth.profileId)) {
    sendJsonResponse(res, 403, {
      ok: false,
      message: '„Теми“ са само за регистрирани потребители.',
    })
    return true
  }

  const topicId = decodeURIComponent(match[1] ?? '')
  const rootMessageId = decodeURIComponent(match[2] ?? '')
  const rootMessage = topicMessageStore.getMessageById(rootMessageId)
  if (
    rootMessage === null ||
    rootMessage.topicId !== topicId ||
    rootMessage.parentMessageId !== null ||
    rootMessage.deletedAt !== null
  ) {
    sendJsonResponse(res, 404, {
      ok: false,
      message: 'Разговорът не беше намерен.',
    })
    return true
  }

  const result = topicReadStateStore.markThreadSeenToLatestSeq(auth.profileId, rootMessageId)
  if (!result.ok) {
    sendJsonResponse(res, 404, {
      ok: false,
      message: 'Разговорът не беше намерен.',
    })
    return true
  }

  broadcastTopicThreadSeenUpdatedToProfile(auth.profileId, topicId, rootMessageId, result.state.lastSeenSeq)
  sendJsonResponse(res, 200, {
    ok: true,
    topicId,
    rootMessageId,
    lastSeenSeq: result.state.lastSeenSeq,
    unreadCount: 0,
    topicUnreadCount: getTopicUnreadCountForProfile(auth.profileId, topicId),
  })
  return true
}

function clampTopicMessagesLimit(rawValue: string | null): number {
  const parsed = rawValue !== null ? Number.parseInt(rawValue, 10) : NaN
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return TOPIC_MESSAGES_DEFAULT_LIMIT
  }
  return Math.min(parsed, TOPIC_MESSAGES_MAX_LIMIT)
}

async function handleTopicMessagesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  requestUrl: URL,
): Promise<boolean> {
  const match = /^\/api\/topics\/([^/]+)\/messages$/.exec(pathname)
  if (!match || req.method !== 'GET') {
    return false
  }

  activityCounters.incrementTopics('topicMessagesRequests')

  const auth = requireRegisteredProfileSession(req)
  if (!auth.ok) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си, за да разгледаш „Теми“.',
    })
    return true
  }

  const topicId = decodeURIComponent(match[1] ?? '')
  const topic = topicStore.getTopicById(topicId)

  if (topic === null) {
    sendJsonResponse(res, 404, {
      ok: false,
      message: 'Темата не беше намерена.',
    })
    return true
  }

  const excludedSenderProfileIds = [...getLobbyChatBlockedSet(auth.profileId)]

  const beforeRaw = requestUrl.searchParams.get('before')
  const beforeSeq = beforeRaw !== null ? Number.parseInt(beforeRaw, 10) : null

  // "Лафче" initial load (без beforeSeq — не "load older" pagination, виж
  // клиента, който никога не изгражда load-more UI за тази тема): override
  // до LAFCHE_MESSAGE_HISTORY_LIMIT (200), независимо от заявения client
  // ?limit=, вместо стандартния TOPIC_MESSAGES_MAX_LIMIT (50) таван за
  // normal Topics (Лафче брифа §3).
  const limit = topicId === LAFCHE_TOPIC_ID && beforeSeq === null
    ? LAFCHE_MESSAGE_HISTORY_LIMIT
    : clampTopicMessagesLimit(requestUrl.searchParams.get('limit'))

  const page = beforeSeq !== null && Number.isInteger(beforeSeq)
    ? topicMessageStore.getMessagesBefore(topicId, beforeSeq, limit, excludedSenderProfileIds)
    : topicMessageStore.getRecentMessages(topicId, limit, excludedSenderProfileIds)

  // Avatar е derived от canonical profile data (виж коментара в
  // TopicMessageSnapshot.senderAvatarUrl) — не се пази в topic_messages,
  // затова resolve-ваме ТУК, при всяко четене, вместо да snapshot-ваме
  // остарял URL в момента на писане.
  //
  // Batch + dedup (не N+1): събираме уникалните sender profileId-та от
  // страницата и правим ЕДНА заявка (getProfileSnapshotsByIds — вече
  // съществуващ batch helper, ползван и от players directory), вместо
  // getPublicProfile() по едно за всяко от до 30-50-те съобщения в batch-а,
  // с повторни lookup-и за същия автор, ако е писал многократно.
  const uniqueSenderProfileIds = [...new Set(page.messages.map((m) => m.senderProfileId))]
  const senderProfiles = playerProgressStore.getProfileSnapshotsByIds(uniqueSenderProfileIds)
  const avatarUrlByProfileId = new Map(senderProfiles.map((p) => [p.profileId, p.avatarUrl]))
  const activeSectionMutedProfileIds = topicModerationStore.getActiveSectionMutedProfileIds(uniqueSenderProfileIds)

  // Батово likeCount/replyCount/viewerHasLiked за цялата страница (Етап 3,
  // виж topicMessageStore.getMessageAggregatesByIds) — до 4 агрегатни заявки
  // ОБЩО, не N+1 per message. excludedSenderProfileIds прави replyCount
  // viewer-aware (blocked-и replies не се броят — виж коментара в store-а).
  const messageIds = page.messages.map((m) => m.messageId)
  const aggregatesByMessageId = topicMessageStore.getMessageAggregatesByIds(messageIds, auth.profileId, excludedSenderProfileIds)
  const attachmentsByMessageId = topicMessageStore.getAttachmentsByMessageIds(messageIds)
  const unreadCountsByMessageId = topicReadStateStore.getUnreadCountsByRootMessageIds(
    auth.profileId,
    messageIds,
    excludedSenderProfileIds,
  )

  const enrichedMessages = page.messages.map((message) => {
    const aggregates = aggregatesByMessageId.get(message.messageId)
    const attachmentRecord = attachmentsByMessageId.get(message.messageId)
    return {
      ...message,
      senderAvatarUrl: avatarUrlByProfileId.get(message.senderProfileId) ?? null,
      attachment: attachmentRecord
        ? {
            attachmentId: attachmentRecord.storageFilename,
            width: attachmentRecord.width,
            height: attachmentRecord.height,
            byteSize: attachmentRecord.byteSize,
            ...buildTopicAttachmentUrls(topicId, attachmentRecord.storageFilename),
          }
        : null,
      likeCount: aggregates?.likeCount ?? 0,
      replyCount: aggregates?.replyCount ?? 0,
      viewerHasLiked: aggregates?.viewerHasLiked ?? false,
      unreadCount: unreadCountsByMessageId.get(message.messageId) ?? 0,
      isTopicsSectionMuted: activeSectionMutedProfileIds.has(message.senderProfileId),
    }
  })

  sendJsonResponse(res, 200, {
    ok: true,
    topic,
    messages: enrichedMessages,
    hasMore: page.hasMore,
    oldestSeq: page.oldestSeq,
  })
  return true
}

const TOPIC_REPLIES_DEFAULT_LIMIT = 20
const TOPIC_REPLIES_MAX_LIMIT = 50

function clampTopicRepliesLimit(rawValue: string | null): number {
  const parsed = rawValue !== null ? Number.parseInt(rawValue, 10) : NaN
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return TOPIC_REPLIES_DEFAULT_LIMIT
  }
  return Math.min(parsed, TOPIC_REPLIES_MAX_LIMIT)
}

// Reply history — cursor pagination (Етап 3), огледално на root history, но
// forward (getReplies/getRepliesAfter са ASC — replies се четат хронологично
// отгоре-надолу, "Покажи още" зарежда НАПРЕД от последния известен, не назад
// от най-новия). VIP НЕ се изисква тук (само за писане на reply) — regular
// registered non-VIP чете replies свободно, точно като root history.
async function handleTopicRepliesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  requestUrl: URL,
): Promise<boolean> {
  const match = /^\/api\/topics\/([^/]+)\/messages\/([^/]+)\/replies$/.exec(pathname)
  if (!match || req.method !== 'GET') {
    return false
  }

  activityCounters.incrementTopics('topicRepliesRequests')

  const auth = requireRegisteredProfileSession(req)
  if (!auth.ok) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си, за да разгледаш „Теми“.',
    })
    return true
  }

  const topicId = decodeURIComponent(match[1] ?? '')
  const rootMessageId = decodeURIComponent(match[2] ?? '')

  const topic = topicStore.getTopicById(topicId)
  if (topic === null) {
    sendJsonResponse(res, 404, { ok: false, message: 'Темата не беше намерена.' })
    return true
  }

  const rootMessage = topicMessageStore.getMessageById(rootMessageId)
  if (rootMessage === null || rootMessage.topicId !== topicId || rootMessage.deletedAt !== null) {
    sendJsonResponse(res, 404, { ok: false, message: 'Съобщението не беше намерено.' })
    return true
  }

  const excludedSenderProfileIds = [...getLobbyChatBlockedSet(auth.profileId)]
  const limit = clampTopicRepliesLimit(requestUrl.searchParams.get('limit'))
  const afterRaw = requestUrl.searchParams.get('after')
  const afterSeq = afterRaw !== null ? Number.parseInt(afterRaw, 10) : null

  const isGapClosingReconcile = afterSeq !== null && Number.isInteger(afterSeq)
  const page = isGapClosingReconcile
    ? topicMessageStore.getRepliesAfter(rootMessageId, afterSeq!, limit, excludedSenderProfileIds)
    : topicMessageStore.getReplies(rootMessageId, limit, excludedSenderProfileIds)

  // Reopen reconciliation (виж createLobbyFlowController.ts expandReplyThread):
  // getRepliesAfter само добавя НОВИ redове (seq > afterSeq) — soft-delete
  // не пипа seq, затова reply, изтрит СЛЕД като клиентът вече го е кеширал
  // (seq <= afterSeq), никога няма да се появи/изчезне през самия page fetch.
  // Връщаме tombstone id-та само в gap-closing режим — cold load (afterSeq
  // null) няма никакъв кеш за reconcile, затова не му е нужен tombstone списък.
  const deletedMessageIds = isGapClosingReconcile
    ? topicMessageStore.getDeletedReplyIdsUpTo(rootMessageId, afterSeq!)
    : []

  const uniqueSenderProfileIds = [...new Set(page.messages.map((m) => m.senderProfileId))]
  const senderProfiles = playerProgressStore.getProfileSnapshotsByIds(uniqueSenderProfileIds)
  const avatarUrlByProfileId = new Map(senderProfiles.map((p) => [p.profileId, p.avatarUrl]))
  const activeSectionMutedProfileIds = topicModerationStore.getActiveSectionMutedProfileIds(uniqueSenderProfileIds)

  const messageIds = page.messages.map((m) => m.messageId)
  const aggregatesByMessageId = topicMessageStore.getMessageAggregatesByIds(messageIds, auth.profileId)
  const attachmentsByMessageId = topicMessageStore.getAttachmentsByMessageIds(messageIds)

  const enrichedReplies = page.messages.map((message) => {
    const aggregates = aggregatesByMessageId.get(message.messageId)
    const attachmentRecord = attachmentsByMessageId.get(message.messageId)
    return {
      ...message,
      senderAvatarUrl: avatarUrlByProfileId.get(message.senderProfileId) ?? null,
      attachment: attachmentRecord
        ? {
            attachmentId: attachmentRecord.storageFilename,
            width: attachmentRecord.width,
            height: attachmentRecord.height,
            byteSize: attachmentRecord.byteSize,
            ...buildTopicAttachmentUrls(topicId, attachmentRecord.storageFilename),
          }
        : null,
      likeCount: aggregates?.likeCount ?? 0,
      viewerHasLiked: aggregates?.viewerHasLiked ?? false,
      isTopicsSectionMuted: activeSectionMutedProfileIds.has(message.senderProfileId),
    }
  })

  sendJsonResponse(res, 200, {
    ok: true,
    replies: enrichedReplies,
    hasMore: page.hasMore,
    oldestSeq: page.oldestSeq,
    deletedMessageIds,
  })
  return true
}

// Protected attachment download за "Теми" — reuse на СЪЩИЯ модел като
// handleSupportAttachmentDownloadRequest: registered-session auth (не
// изисква VIP — likes/read/download НЕ са VIP функции, само publish е),
// строг UUID.webp filename regex ПРЕДИ join() (path traversal защита),
// attachment↔topic JOIN isolation (getAttachmentForDownload), private
// cache-control, uniform 404 на всеки грешен път.
async function handleTopicAttachmentDownloadRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/topics\/([^/]+)\/attachments\/([^/]+)$/.exec(pathname)
  if (!match || req.method !== 'GET') {
    return false
  }

  const auth = requireRegisteredProfileSession(req)
  if (!auth.ok) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си, за да разгледаш „Теми“.' })
    return true
  }

  const topicId = decodeURIComponent(match[1] ?? '')
  const filename = decodeURIComponent(match[2] ?? '')

  if (!IMAGE_ATTACHMENT_FILENAME_PATTERN.test(filename)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидно име на файл.' })
    return true
  }

  const attachment = topicMessageStore.getAttachmentForDownload(topicId, filename)

  if (attachment === null) {
    sendJsonResponse(res, 404, { ok: false, message: 'Файлът не беше намерен.' })
    return true
  }

  const filePath = join(TOPIC_ATTACHMENT_UPLOADS_PATH, attachment.storageFilename)

  try {
    const fileStats = await stat(filePath)

    if (!fileStats.isFile()) {
      sendJsonResponse(res, 404, { ok: false, message: 'Файлът не беше намерен.' })
      return true
    }

    const fileBuffer = await readFile(filePath)
    const url = new URL(req.url ?? '', 'http://localhost')
    const isDownload = url.searchParams.get('download') !== null

    res.writeHead(200, {
      'Content-Type': attachment.contentType,
      'Cache-Control': 'private, max-age=86400',
      ...(isDownload
        ? { 'Content-Disposition': `attachment; filename="pika-topic-${attachment.storageFilename}"` }
        : {}),
    })
    res.end(fileBuffer)
    return true
  } catch {
    sendJsonResponse(res, 404, { ok: false, message: 'Файлът не беше намерен.' })
    return true
  }
}

// Protected evidence-copy attachment download (Lafche retention hotfix) —
// СЪЩИЯТ response модел като handleTopicAttachmentDownloadRequest, но:
//  - moderator-only auth (isTopicModeratorSession), НЕ обикновена registered
//    сесия — evidence снимки не са normal public-to-registered Lafche
//    съдържание, само модераторският "моята история"/evidence flow ги вижда;
//  - authorization/isolation през topicModerationStore.isRegisteredEvidenceAttachmentCopy
//    (СЪЩАТА цел като attachment↔topic JOIN isolation-a в normal handler-а —
//    предотвратява enumeration на файлове в protected evidence storage-a
//    чрез познат UUID.webp filename), НЕ topic_messages/topic_message_attachments
//    JOIN (source-ът вече може да е hard-deleted до момента на този request).
async function handleTopicMuteEvidenceAttachmentDownloadRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/topics\/mute-evidence\/attachments\/([^/]+)$/.exec(pathname)
  if (!match || req.method !== 'GET') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isTopicModeratorSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
    return true
  }

  const filename = decodeURIComponent(match[1] ?? '')

  if (!IMAGE_ATTACHMENT_FILENAME_PATTERN.test(filename)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидно име на файл.' })
    return true
  }

  if (!topicModerationStore.isRegisteredEvidenceAttachmentCopy(filename)) {
    sendJsonResponse(res, 404, { ok: false, message: 'Файлът не беше намерен.' })
    return true
  }

  const filePath = join(TOPIC_MUTE_EVIDENCE_ATTACHMENT_UPLOADS_PATH, filename)

  try {
    const fileStats = await stat(filePath)

    if (!fileStats.isFile()) {
      sendJsonResponse(res, 404, { ok: false, message: 'Файлът не беше намерен.' })
      return true
    }

    const fileBuffer = await readFile(filePath)

    res.writeHead(200, {
      'Content-Type': 'image/webp',
      'Cache-Control': 'private, max-age=86400',
    })
    res.end(fileBuffer)
    return true
  } catch {
    sendJsonResponse(res, 404, { ok: false, message: 'Файлът не беше намерен.' })
    return true
  }
}

// ─── Topics Moderation (Етап 4) ────────────────────────────────────────────
//
// Moderation actions (lock/unlock/mute/unmute/delete) минават през HTTP, НЕ
// WS — established convention за moderation в проекта (виж
// handleLobbyChatDeleteRequest коментара: "прясна cookie-based сесийна
// проверка на всяко изтриване, не роля кеширана само при WS handshake-а на
// дълготрайна връзка"). Realtime notify на РЕЗУЛТАТА reuse-ва СЪЩИЯ WS канал
// като останалите Topics събития (topicMessageSubscribersByTopicId) — не
// втора паралелна infrastructure.

// Предварително планирани duration опции (брифа т.2) — валидирани server-
// side по exact milliseconds match, не free-form число от клиента (защита
// срещу произволна/абсурдна duration стойност).
const TOPIC_MODERATION_ALLOWED_DURATIONS_MS = [
  30 * 60 * 1000,
  60 * 60 * 1000,
  3 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
]

const TOPIC_MODERATION_REASON_MAX_LENGTH = 200

function parseTopicModerationReason(rawReason: unknown): string | null {
  if (typeof rawReason !== 'string') return null
  const trimmed = rawReason.trim()
  if (trimmed.length === 0 || trimmed.length > TOPIC_MODERATION_REASON_MAX_LENGTH) return null
  return trimmed
}

function parseTopicModerationDurationMs(rawDurationMs: unknown): number | null {
  if (typeof rawDurationMs !== 'number' || !Number.isFinite(rawDurationMs)) return null
  return TOPIC_MODERATION_ALLOWED_DURATIONS_MS.includes(rawDurationMs) ? rawDurationMs : null
}

const TOPIC_MUTE_EVIDENCE_SOURCE_KINDS = ['lafche_post', 'topic_root', 'topic_reply', 'unspecified'] as const
const TOPIC_MUTE_EVIDENCE_REASON_CATEGORIES = ['insults', 'provocation', 'spam', 'inappropriate_content', 'other'] as const

/**
 * client-provided sourceMessageId/sourceKind са ЕДИНСТВЕНО "кой пост е бил
 * визуално отворен, когато moderator-ът натисна мутиращия бутон" — само
 * ROUTING hint. Реалният evidence snapshot (body/attachment) се зарежда
 * server-side ОТ DB, НИКОГА от client payload (mute-evidence брифа §3: "Не
 * вярвай на content, изпратен от клиента") — виж insertMuteEvidence в
 * topicModerationStore.ts, което прави собствен SELECT по messageId, без
 * значение какво клиентът твърди за съдържанието.
 */
function parseTopicMuteEvidenceSourceMessageId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseTopicMuteEvidenceSourceKind(raw: unknown): TopicMuteEvidenceSourceKind {
  return typeof raw === 'string' && (TOPIC_MUTE_EVIDENCE_SOURCE_KINDS as readonly string[]).includes(raw)
    ? (raw as TopicMuteEvidenceSourceKind)
    : 'unspecified'
}

function parseTopicMuteEvidenceReasonCategory(raw: unknown): TopicMuteEvidenceReasonCategory | null {
  return typeof raw === 'string' && (TOPIC_MUTE_EVIDENCE_REASON_CATEGORIES as readonly string[]).includes(raw)
    ? (raw as TopicMuteEvidenceReasonCategory)
    : null
}

// isTopicModeratorSession гарантира role !== 'player'/'chat_admin'/'guest' —
// type predicate стеснява само session (non-null), не и вложеното
// account.role поле, затова explicit cast тук (огледално на
// handleLobbyChatDeleteRequest коментара за actorRoleAtDeletion).
function toTopicModeratorRole(session: AuthSessionSnapshot): TopicModeratorRole {
  return session.account.role as TopicModeratorRole
}

async function handleTopicLockRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/topics\/([^/]+)\/lock$/.exec(pathname)
  if (!match || req.method !== 'POST') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isTopicWholeTopicModeratorSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш право да заключваш теми.' })
    return true
  }

  const topicId = decodeURIComponent(match[1] ?? '')

  // "Лафче" е fixed system тема — не може да се заключва (огледално на
  // client-side guard-а в renderTopicHeaderModerationControls). Тесен guard
  // само за този topicId, не засяга lock права за нормални теми.
  if (topicId === LAFCHE_TOPIC_ID) {
    sendJsonResponse(res, 403, { ok: false, message: '„Лафче“ не може да бъде заключвана.' })
    return true
  }

  const topic = topicStore.getTopicById(topicId)
  if (topic === null || topic.status === 'removed') {
    sendJsonResponse(res, 404, { ok: false, message: 'Темата не беше намерена.' })
    return true
  }

  let body: unknown
  try {
    body = await readJsonRequestBody(req)
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидна заявка.' })
    return true
  }
  const parsedBody = body as { reason?: unknown; durationMs?: unknown }

  const reason = parseTopicModerationReason(parsedBody.reason)
  if (reason === null) {
    sendJsonResponse(res, 400, { ok: false, message: 'Липсва или невалидна причина.' })
    return true
  }
  const durationMs = parseTopicModerationDurationMs(parsedBody.durationMs)
  if (durationMs === null) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидна продължителност.' })
    return true
  }

  const lockSnapshot = topicModerationStore.lockTopic({
    topicId,
    actorAccountId: session.account.accountId,
    actorRole: toTopicModeratorRole(session),
    reason,
    durationMs,
  })

  broadcastTopicLockStateChangedToLocalSubscribers(topicId, lockSnapshot)

  sendJsonResponse(res, 200, { ok: true, lock: lockSnapshot })
  return true
}

async function handleTopicUnlockRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/topics\/([^/]+)\/unlock$/.exec(pathname)
  if (!match || req.method !== 'POST') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isTopicWholeTopicModeratorSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш право да отключваш теми.' })
    return true
  }

  const topicId = decodeURIComponent(match[1] ?? '')

  // "Лафче" никога не може да бъде заключена (виж handleTopicLockRequest),
  // значи unlock е defensively guard-нат тук също — не засяга нормални теми.
  if (topicId === LAFCHE_TOPIC_ID) {
    sendJsonResponse(res, 403, { ok: false, message: '„Лафче“ не може да бъде заключвана.' })
    return true
  }

  const topic = topicStore.getTopicById(topicId)
  if (topic === null || topic.status === 'removed') {
    sendJsonResponse(res, 404, { ok: false, message: 'Темата не беше намерена.' })
    return true
  }

  // Idempotent — unlock на вече отключена/изтекла тема е no-op success, не
  // грешка (брифа т.12: "не връщай generic server error при harmless
  // repeated action"). changed=false пропуска излишен broadcast/audit ред.
  const { changed, snapshot } = topicModerationStore.unlockTopic({
    topicId,
    actorAccountId: session.account.accountId,
    actorRole: toTopicModeratorRole(session),
  })

  if (changed) {
    broadcastTopicLockStateChangedToLocalSubscribers(topicId, snapshot)
  }

  sendJsonResponse(res, 200, { ok: true, lock: snapshot })
  return true
}

// Lazy lookup за MUTE/UNMUTE UI бутона до автор (виж renderTopicsScreen.ts
// data-topic-mute-toggle) — клиентът НЕ batch-hydrate-ва mute state за
// всеки автор в message list-а (би било extra query на всеки render за рядко
// ползвана moderator-only функция), затова fetch-ва при самия click.
async function handleTopicMuteStatusRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  requestUrl: URL,
): Promise<boolean> {
  const match = /^\/api\/topics\/([^/]+)\/mute-status$/.exec(pathname)
  if (!match || req.method !== 'GET') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  const topicId = decodeURIComponent(match[1] ?? '')

  // "Лафче" (topic-lafche) — само admin/pika_team/top_chat_admin, за
  // разлика от normal Topics (isTopicModeratorSession, 4 роли вкл.
  // subadmin) — виж isLafcheModeratorSession коментара в authStore.ts.
  const isAllowed = topicId === LAFCHE_TOPIC_ID
    ? isLafcheModeratorSession(session)
    : isTopicModeratorSession(session)

  if (!isAllowed) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
    return true
  }

  const profileId = requestUrl.searchParams.get('profileId')
  if (!profileId) {
    sendJsonResponse(res, 400, { ok: false, message: 'Липсва потребител.' })
    return true
  }

  // Global Topics-section mute lookup (виж GLOBAL TOPICS MUTE брифа) —
  // topicId в URL-а е само UI context (модераторът гледа този конкретен
  // потребител от тази конкретна тема), НЕ enforcement scope. Статусът е
  // еднакъв независимо от кой topicId е подаден тук.
  sendJsonResponse(res, 200, { ok: true, mute: topicModerationStore.getSectionMuteSnapshot(profileId) })
  return true
}

async function handleTopicMuteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/topics\/([^/]+)\/mute$/.exec(pathname)
  if (!match || req.method !== 'POST') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  const topicId = decodeURIComponent(match[1] ?? '')

  // "Лафче" (topic-lafche) — само admin/pika_team/top_chat_admin (Лафче
  // брифа §6/§7), за разлика от normal Topics 4-role set-а по-долу.
  // Explicit session===null check СЛЕД isAllowed (не само вътре в
  // predicate-ите) — тернарният isAllowed сам не narrow-ва session за TS,
  // mirror на established isModerator pattern-а в handleTopicMessageDeleteRequest.
  const isAllowed = topicId === LAFCHE_TOPIC_ID
    ? isLafcheModeratorSession(session)
    : isTopicModeratorSession(session)

  if (!isAllowed || session === null) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш право да заглушаваш потребители.' })
    return true
  }

  const topic = topicStore.getTopicById(topicId)
  if (topic === null || topic.status === 'removed') {
    sendJsonResponse(res, 404, { ok: false, message: 'Темата не беше намерена.' })
    return true
  }

  let body: unknown
  try {
    body = await readJsonRequestBody(req)
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидна заявка.' })
    return true
  }
  const parsedBody = body as {
    profileId?: unknown
    reason?: unknown
    durationMs?: unknown
    sourceMessageId?: unknown
    sourceKind?: unknown
    reasonCategory?: unknown
  }

  const targetProfileId = typeof parsedBody.profileId === 'string' ? parsedBody.profileId.trim() : ''
  if (targetProfileId.length === 0) {
    sendJsonResponse(res, 400, { ok: false, message: 'Липсва потребител.' })
    return true
  }
  const reason = parseTopicModerationReason(parsedBody.reason)
  if (reason === null) {
    sendJsonResponse(res, 400, { ok: false, message: 'Липсва или невалидна причина.' })
    return true
  }
  const durationMs = parseTopicModerationDurationMs(parsedBody.durationMs)
  if (durationMs === null) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидна продължителност.' })
    return true
  }
  // sourceMessageId/sourceKind/reasonCategory — виж parseTopicMuteEvidenceSourceMessageId
  // коментара по-горе: само routing hint, реалният snapshot се зарежда
  // server-side от DB вътре в muteProfileInTopics/insertMuteEvidence.
  const sourceMessageId = parseTopicMuteEvidenceSourceMessageId(parsedBody.sourceMessageId)
  const sourceKind = parseTopicMuteEvidenceSourceKind(parsedBody.sourceKind)
  const reasonCategory = parseTopicMuteEvidenceReasonCategory(parsedBody.reasonCategory)

  // Global Topics-section mute (виж GLOBAL TOPICS MUTE брифа) — topicId
  // остава само audit/source context (кой topic е бил отворен, когато
  // модераторът е натиснал "Заглуши"), enforcement-ът важи навсякъде в
  // Теми след тази заявка.
  const muteSnapshot = topicModerationStore.muteProfileInTopics({
    topicId,
    profileId: targetProfileId,
    actorAccountId: session.account.accountId,
    actorRole: toTopicModeratorRole(session),
    reason,
    reasonCategory,
    durationMs,
    sourceMessageId,
    sourceKind,
  })

  notifyProfileOfTopicMuteStateChange(targetProfileId, topicId, muteSnapshot)
  broadcastTopicsSectionMuteIndicatorChange(targetProfileId, muteSnapshot.isMuted)

  sendJsonResponse(res, 200, { ok: true, mute: muteSnapshot })
  return true
}

async function handleTopicUnmuteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/topics\/([^/]+)\/unmute$/.exec(pathname)
  if (!match || req.method !== 'POST') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  const topicId = decodeURIComponent(match[1] ?? '')

  // "Лафче" (topic-lafche) — само admin/pika_team/top_chat_admin (Лафче
  // брифа §6/§7), за разлика от normal Topics 4-role set-а по-долу.
  // Explicit session===null check СЛЕД isAllowed (не само вътре в
  // predicate-ите), mirror на handleTopicMuteRequest по-горе.
  const isAllowed = topicId === LAFCHE_TOPIC_ID
    ? isLafcheModeratorSession(session)
    : isTopicModeratorSession(session)

  if (!isAllowed || session === null) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш право да отглушаваш потребители.' })
    return true
  }

  const topic = topicStore.getTopicById(topicId)
  if (topic === null || topic.status === 'removed') {
    sendJsonResponse(res, 404, { ok: false, message: 'Темата не беше намерена.' })
    return true
  }

  let body: unknown
  try {
    body = await readJsonRequestBody(req)
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидна заявка.' })
    return true
  }
  const targetProfileId = typeof (body as { profileId?: unknown }).profileId === 'string'
    ? ((body as { profileId: string }).profileId).trim()
    : ''
  if (targetProfileId.length === 0) {
    sendJsonResponse(res, 400, { ok: false, message: 'Липсва потребител.' })
    return true
  }

  // Early unmute (виж GLOBAL TOPICS MUTE брифа §13): трие global
  // topic_section_mutes реда directno — legacy per-topic topic_mutes
  // редове НЕ се пипат тук и НЕ могат да "реактивират" санкцията, защото
  // enforcement вече чете изключително от topic_section_mutes.
  const { changed } = topicModerationStore.unmuteProfileInTopics({
    topicId,
    profileId: targetProfileId,
    actorAccountId: session.account.accountId,
    actorRole: toTopicModeratorRole(session),
  })

  if (changed) {
    notifyProfileOfTopicMuteStateChange(targetProfileId, topicId, { isMuted: false, mutedUntil: null, reason: null })
    broadcastTopicsSectionMuteIndicatorChange(targetProfileId, false)
  }

  sendJsonResponse(res, 200, { ok: true })
  return true
}

/**
 * User-facing "моята история" (mute-evidence брифа §6/§8) — само собствените
 * records на автентикирания потребител, НИКОГА чужди (profileId идва
 * ИЗКЛЮЧИТЕЛНО от сесията, никога от URL/query параметър — за разлика от
 * internal endpoint-а по-долу). Moderator identity (mutedByAccountId)
 * ИЗРИЧНО маха от response-а тук — виж §6: "На потребителя НЕ показвай кой
 * конкретен moderator го е наложил". Attachment view/download URLs се
 * изграждат само ако source_kind/attachment все още препращат към жив
 * topic_id (buildTopicAttachmentUrls изисква topicId) — sourceTopicId
 * винаги присъства (NOT NULL колона), значи винаги е safe да се build-нат.
 */
async function handleTopicMuteEvidenceForSelfRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/topics/mute-evidence/mine' || req.method !== 'GET') {
    return false
  }

  const auth = requireRegisteredProfileSession(req)
  if (!auth.ok) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }

  const entries = topicModerationStore.listMuteEvidenceForProfile(auth.profileId, 50)

  sendJsonResponse(res, 200, {
    ok: true,
    entries: entries.map((entry) => ({
      muteHistoryId: entry.muteHistoryId,
      sourceKind: entry.sourceKind,
      sourceBodySnapshot: entry.sourceBodySnapshot,
      sourceAttachment: entry.sourceAttachment
        ? { ...buildTopicMuteEvidenceAttachmentUrls(entry.sourceTopicId, entry.sourceAttachment.storageFilename, entry.sourceAttachment.isEvidenceCopy), width: entry.sourceAttachment.width, height: entry.sourceAttachment.height }
        : null,
      sourceCreatedAt: entry.sourceCreatedAt,
      originalMessagePostDeleted: entry.originalMessageDeletedAt !== null,
      reasonText: entry.reasonText,
      reasonCategory: entry.reasonCategory,
      durationMs: entry.durationMs,
      mutedUntil: entry.mutedUntil,
      status: entry.status,
      unmutedAt: entry.unmutedAt,
      createdAt: entry.createdAt,
      // mutedByAccountId/unmutedByAccountId ИЗРИЧНО НЕ се излагат тук.
    })),
  })
  return true
}

/**
 * Internal/moderator пълен audit изглед (mute-evidence брифа §7/§8) — носи
 * moderator identity (mutedByAccountId/unmutedByAccountId), reuse-ва
 * isTopicModeratorSession (СЪЩИЯТ достъп като mute-status/mute/unmute
 * endpoints по-горе, 4 роли: admin/subadmin/pika_team/top_chat_admin) — НЕ
 * тесния isLafcheModeratorSession, защото историята обхваща mutes от ВСИЧКИ
 * Topics контексти (General/user topics/Лафче), не само Лафче-specific
 * действия (§8: "Internal moderation: използвай съществуващите Topics
 * moderation permissions").
 */
async function handleTopicMuteEvidenceForModeratorRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  requestUrl: URL,
): Promise<boolean> {
  const match = /^\/api\/topics\/mute-evidence\/profile\/([^/]+)$/.exec(pathname)
  if (!match || req.method !== 'GET') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isTopicModeratorSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
    return true
  }

  const profileId = decodeURIComponent(match[1] ?? '')
  const limitRaw = requestUrl.searchParams.get('limit')
  const limitParsed = limitRaw !== null ? Number.parseInt(limitRaw, 10) : NaN
  const limit = Number.isInteger(limitParsed) && limitParsed > 0 ? limitParsed : 50

  const entries = topicModerationStore.listMuteEvidenceForProfile(profileId, limit)

  sendJsonResponse(res, 200, {
    ok: true,
    entries: entries.map((entry) => ({
      muteHistoryId: entry.muteHistoryId,
      muteAuditLogId: entry.muteAuditLogId,
      sourceTopicId: entry.sourceTopicId,
      sourceMessageId: entry.sourceMessageId,
      sourceKind: entry.sourceKind,
      sourceBodySnapshot: entry.sourceBodySnapshot,
      sourceAttachment: entry.sourceAttachment
        ? { ...buildTopicMuteEvidenceAttachmentUrls(entry.sourceTopicId, entry.sourceAttachment.storageFilename, entry.sourceAttachment.isEvidenceCopy), width: entry.sourceAttachment.width, height: entry.sourceAttachment.height }
        : null,
      sourceCreatedAt: entry.sourceCreatedAt,
      originalMessageDeletedAt: entry.originalMessageDeletedAt,
      mutedByAccountId: entry.mutedByAccountId,
      mutedByRole: entry.mutedByRole,
      reasonText: entry.reasonText,
      reasonCategory: entry.reasonCategory,
      durationMs: entry.durationMs,
      mutedUntil: entry.mutedUntil,
      status: entry.status,
      unmutedAt: entry.unmutedAt,
      unmutedByAccountId: entry.unmutedByAccountId,
      createdAt: entry.createdAt,
    })),
  })
  return true
}

async function handleTopicDeleteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/topics\/([^/]+)$/.exec(pathname)
  if (!match || req.method !== 'DELETE') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isTopicWholeTopicModeratorSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш право да триеш теми.' })
    return true
  }

  const topicId = decodeURIComponent(match[1] ?? '')

  // "Лафче" е fixed system тема — не може да се изтрива (огледално на
  // client-side guard-а в renderTopicHeaderModerationControls). Тесен guard
  // само за този topicId, не засяга delete права за нормални теми.
  if (topicId === LAFCHE_TOPIC_ID) {
    sendJsonResponse(res, 403, { ok: false, message: '„Лафче“ не може да бъде изтрита.' })
    return true
  }

  let body: unknown
  try {
    body = await readJsonRequestBody(req)
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидна заявка.' })
    return true
  }
  const reason = parseTopicModerationReason((body as { reason?: unknown }).reason)
  if (reason === null) {
    sendJsonResponse(res, 400, { ok: false, message: 'Липсва или невалидна причина.' })
    return true
  }

  // topicModerationStore.deleteTopic е canonical transaction owner — hard-
  // delete на attachment redovete + queue insertion за физически cleanup
  // стават В ЕДНА BEGIN IMMEDIATE транзакция ВЪТРЕ в store-а (виж коментара
  // там), не отделни enqueue извиквания тук след commit. Никакъв прозорец
  // между "DB reference изтрит" и "queue job insert-нат".
  const result = topicModerationStore.deleteTopic({
    topicId,
    actorAccountId: session.account.accountId,
    actorRole: toTopicModeratorRole(session),
    reason,
  })

  if (!result.ok && result.code === 'not_found') {
    sendJsonResponse(res, 404, { ok: false, message: 'Темата не беше намерена.' })
    return true
  }

  // already_removed третираме идентично на success навън — идемпотентно
  // (брифа т.12), темата вече гарантирано е премахната при връщане 200.
  if (result.ok) {
    broadcastTopicDeletedToLocalSubscribers(topicId)
  }

  sendJsonResponse(res, 200, { ok: true, topicId })
  return true
}

// Individual root съобщение/reply moderation delete — различно от
// handleTopicDeleteRequest по-горе (whole-topic delete). Регистриран ПРЕДИ
// handleTopicDeleteRequest в route dispatch-а (по-специфичен path с 4
// сегмента, /api/topics/:topicId/messages/:messageId — regex-ът на
// handleTopicDeleteRequest е anchored с $ веднага след :topicId capture
// group-а, значи технически не би пресякъл този по-дълъг path, но
// established convention в проекта е по-специфични routes първи).
// Unified DELETE endpoint — поддържа ДВА authorization пътя (own-delete-own-
// content брифа §11/§12): (A) moderator (established 5-role permission set,
// thread-wide root delete semantics непроменени), (B) ordinary author,
// изтриващ СОБСТВЕНО съобщение/reply (нов, по-тесен delete модел — root
// delete-нат само ако 0 live replies, виж deleteOwnMessage()). Store
// semantics НЕ се смесват: moderator path вика established deleteMessage(),
// owner path вика новия deleteOwnMessage() — двете имат различни guarantees
// и НИКОГА не се извикват взаимозаменяемо.
async function handleTopicMessageDeleteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/topics\/([^/]+)\/messages\/([^/]+)$/.exec(pathname)
  if (!match || req.method !== 'DELETE') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null || session.profile.profileId === null) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }

  const topicId = decodeURIComponent(match[1] ?? '')
  const messageId = decodeURIComponent(match[2] ?? '')

  // isTopicMessageModeratorSession е type predicate (session is
  // AuthSessionSnapshot) — извикването му тук би narrow-нало session-а по
  // начин, който TS после третира като incompatible intersection в '!'
  // branch-а (session вече е established non-null от null-check-а по-горе).
  // Explicit role-set сравнение вместо reuse на predicate-a избягва тази
  // TS control-flow особеност, без промяна в семантиката.
  //
  // "Лафче" (topic-lafche) е изключение — admin/pika_team/top_chat_admin +
  // chat_admin (isLafcheMessageDeleteModeratorSession, БЕЗ subadmin), за
  // delete parity с normal Topics 5-role set-а по-долу (chat_admin delete
  // parity fix — mute/unmute/report/audit в Лафче продължават да ползват
  // isLafcheModeratorSession непроменено, БЕЗ chat_admin). Branch-ът е строго
  // по topicId, за да не пипа moderation правата за General/user-created теми.
  const isModerator = topicId === LAFCHE_TOPIC_ID
    ? isLafcheMessageDeleteModeratorSession(session)
    : (
      session.account.role === 'admin'
      || session.account.role === 'subadmin'
      || session.account.role === 'top_chat_admin'
      || session.account.role === 'pika_team'
      || session.account.role === 'chat_admin'
    )

  // Guest/temporary profiles никога не могат да бъдат sender_profile_id на
  // topic съобщение (established write guard), значи те никога не могат да
  // бъдат owner — единствената валидна причина да продължат тук е ако СА
  // moderator (moderator ролите не могат да бъдат temporary profiles на
  // практика, но guard-ът остава explicit за яснота, mirror на established
  // isTemporaryProfile проверки другаде).
  if (!isModerator && playerProgressStore.isTemporaryProfile(session.profile.profileId)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш право да триеш съобщения в „Теми“.' })
    return true
  }

  const topic = topicStore.getTopicById(topicId)

  // removed тема: individual-message endpoint не работи там — whole-topic
  // 180-day retention/purge (topicModerationStore.purgeRemovedTopicsBefore,
  // anchored от topics.removed_at) е authoritative за removed теми, mirror
  // на established removed-третиране в send_topic_message/handleTopicReportRequest
  // (individual-message-moderation брифа §27, own-delete брифа §5/§27).
  if (topic === null || topic.status === 'removed') {
    sendJsonResponse(res, 404, { ok: false, message: 'Темата не беше намерена.' })
    return true
  }

  // LOCKED topic: delete Е РАЗРЕШЕН тук нарочно (и за moderator, И за own-
  // delete) — locked спира само нови user writes (send_topic_message/
  // send_topic_reply), НЕ delete actions (established прецедент: whole-topic
  // lock/unlock/mute също работят в locked тема; own-delete брифа §5 explicit
  // потвърждава same третиране за author delete). НЕ извикваме
  // getTopicLockSnapshot guard тук.

  if (isModerator) {
    // isTopicMessageModeratorSession гарантира role е един от петте
    // individual-message-moderation роли — типовият predicate стеснява само
    // session (non-null), не и вложеното account.role поле, затова explicit
    // cast тук (огледално на toTopicModeratorRole/handleLobbyChatDeleteRequest
    // коментара). Established thread-wide root delete semantics — НЕПРОМЕНЕНИ.
    const result = topicMessageStore.deleteMessage({
      topicId,
      messageId,
      actorAccountId: session.account.accountId,
      actorRole: session.account.role as 'admin' | 'subadmin' | 'top_chat_admin' | 'pika_team' | 'chat_admin',
    })

    if (!result.ok && result.code === 'not_found') {
      sendJsonResponse(res, 404, { ok: false, message: 'Съобщението не беше намерено.' })
      return true
    }

    // already_deleted третираме идентично на success навън — идемпотентно,
    // съобщението вече гарантирано не съществува в потока при връщане 200.
    if (result.ok) {
      topicMessageLastAnnouncedDeletionEventSeq = topicMessageStore.getMaxDeletionEventSeq()
      broadcastTopicMessageDeletedToLocalSubscribers(topicId, messageId, result.parentMessageId, result.deletedAt)
    }

    sendJsonResponse(res, 200, { ok: true, topicId, messageId })
    return true
  }

  // "Лафче" (topic-lafche) няма own-delete право изобщо — единственият
  // валиден path е moderator (isModerator блокът по-горе, isLafcheModeratorSession).
  // За разлика от normal Topics, фактът че потребителят е автор на поста
  // НЕ му дава delete право тук — reuse-ва СЪЩИЯ topicId===LAFCHE_TOPIC_ID
  // branch, който вече определи isModerator по-горе (не дублира permission
  // helper). Normal Topics own-delete остава напълно непроменено.
  if (topicId === LAFCHE_TOPIC_ID) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш право да изтриеш това съобщение.' })
    return true
  }

  // НЕ moderator — единственият друг валиден authorization път е owner.
  // Handler-level pre-check дава точната HTTP семантика за live чуждо
  // съобщение в същата тема (403), докато deleteOwnMessage() остава
  // authoritative defense-in-depth re-check вътре в store-а/transaction-а.
  const targetMessage = topicMessageStore.getMessageById(messageId)
  if (
    targetMessage !== null
    && targetMessage.topicId === topicId
    && targetMessage.deletedAt === null
    && targetMessage.senderProfileId !== session.profile.profileId
  ) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш право да изтриеш това съобщение.' })
    return true
  }

  const result = topicMessageStore.deleteOwnMessage({
    topicId,
    messageId,
    ownerProfileId: session.profile.profileId,
  })

  if (!result.ok && result.code === 'not_found') {
    sendJsonResponse(res, 404, { ok: false, message: 'Съобщението не беше намерено.' })
    return true
  }

  if (!result.ok && result.code === 'has_live_replies') {
    sendJsonResponse(res, 409, {
      ok: false,
      code: 'has_live_replies',
      message: 'Не можеш да изтриеш публикация, към която вече има отговори.',
    })
    return true
  }

  if (result.ok) {
    topicMessageLastAnnouncedDeletionEventSeq = topicMessageStore.getMaxDeletionEventSeq()
    broadcastTopicMessageDeletedToLocalSubscribers(topicId, messageId, result.parentMessageId, result.deletedAt)
  }

  sendJsonResponse(res, 200, { ok: true, topicId, messageId })
  return true
}

async function handleTopicMessageEditRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/topics\/([^/]+)\/messages\/([^/]+)$/.exec(pathname)
  if (!match || req.method !== 'PATCH') {
    return false
  }

  const auth = requireRegisteredProfileSession(req)
  if (!auth.ok) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }

  if (playerProgressStore.isTemporaryProfile(auth.profileId)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш право да редактираш съобщения в „Теми“.' })
    return true
  }

  const topicId = decodeURIComponent(match[1] ?? '')
  const messageId = decodeURIComponent(match[2] ?? '')

  const topic = topicStore.getTopicById(topicId)
  if (topic === null || topic.status === 'removed') {
    sendJsonResponse(res, 404, { ok: false, message: 'Темата не беше намерена.' })
    return true
  }

  const lockSnapshot = topicModerationStore.getTopicLockSnapshot(topicId)
  if (lockSnapshot?.isLocked) {
    sendJsonResponse(res, 409, { ok: false, code: 'topic_locked', message: 'Темата е заключена.' })
    return true
  }

  let body: unknown
  try {
    body = await readJsonRequestBody(req)
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидна заявка.' })
    return true
  }

  const rawBody = (body as { body?: unknown }).body
  if (typeof rawBody !== 'string') {
    sendJsonResponse(res, 400, { ok: false, code: 'invalid_body', message: 'Невалиден текст.' })
    return true
  }

  const targetMessage = topicMessageStore.getMessageById(messageId)
  if (
    targetMessage !== null
    && targetMessage.topicId === topicId
    && targetMessage.deletedAt === null
    && targetMessage.senderProfileId !== auth.profileId
  ) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш право да редактираш това съобщение.' })
    return true
  }

  const result = topicMessageStore.editOwnMessage({
    topicId,
    messageId,
    ownerProfileId: auth.profileId,
    body: rawBody,
  })

  if (!result.ok && result.code === 'not_found') {
    sendJsonResponse(res, 404, { ok: false, message: 'Съобщението не беше намерено.' })
    return true
  }

  if (!result.ok && result.code === 'edit_window_expired') {
    sendJsonResponse(res, 409, { ok: false, code: 'edit_window_expired', message: 'Времето за редакция изтече.' })
    return true
  }

  if (!result.ok && result.code === 'has_live_replies') {
    sendJsonResponse(res, 409, {
      ok: false,
      code: 'has_live_replies',
      message: 'Не можете да редактирате публикация, към която вече има отговори.',
    })
    return true
  }

  if (
    !result.ok
    && (result.code === 'empty_body' || result.code === 'body_too_long' || result.code === 'invalid_body')
  ) {
    const validationMessageByCode: Record<'empty_body' | 'body_too_long' | 'invalid_body', string> = {
      empty_body: 'Съобщението не може да е празно.',
      body_too_long: `Съобщението е твърде дълго. Максимум ${TOPIC_MESSAGE_MAX_BODY_CODE_POINTS} символа.`,
      invalid_body: 'Съобщението съдържа неподдържани символи.',
    }
    sendJsonResponse(res, 400, { ok: false, code: result.code, message: validationMessageByCode[result.code] })
    return true
  }

  if (!result.ok) {
    sendJsonResponse(res, 400, { ok: false, code: result.code, message: 'Редакцията не беше приета.' })
    return true
  }

  if (result.changed) {
    topicMessageLastAnnouncedEditEventSeq = topicMessageStore.getMaxEditEventSeq()
    broadcastTopicMessageEditedToLocalSubscribers(topicId, result.message)
  }

  sendJsonResponse(res, 200, {
    ok: true,
    topicId,
    messageId,
    parentMessageId: result.message.parentMessageId,
    body: result.message.body,
    editedAt: result.message.editedAt,
    changed: result.changed,
  })
  return true
}

const TOPIC_REPORT_REASON_MAX_LENGTH = 300

async function handleTopicReportRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/topics\/([^/]+)\/report$/.exec(pathname)
  if (!match || req.method !== 'POST') {
    return false
  }

  const auth = requireRegisteredProfileSession(req)
  if (!auth.ok) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }

  if (playerProgressStore.isTemporaryProfile(auth.profileId)) {
    sendJsonResponse(res, 403, { ok: false, message: '„Теми“ само за регистрирани потребители.' })
    return true
  }

  const topicId = decodeURIComponent(match[1] ?? '')
  const topic = topicStore.getTopicById(topicId)
  if (topic === null || topic.status === 'removed') {
    sendJsonResponse(res, 404, { ok: false, message: 'Темата не беше намерена.' })
    return true
  }

  let body: unknown
  try {
    body = await readJsonRequestBody(req)
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидна заявка.' })
    return true
  }
  const rawReason = (body as { reason?: unknown }).reason
  const reason = typeof rawReason === 'string' ? rawReason.trim() : ''
  if (reason.length === 0 || reason.length > TOPIC_REPORT_REASON_MAX_LENGTH) {
    sendJsonResponse(res, 400, { ok: false, message: 'Липсва или невалидна причина.' })
    return true
  }

  // reporter identity ИЗКЛЮЧИТЕЛНО от authenticated session (auth.profileId
  // от requireRegisteredProfileSession) — НИКОГА client-provided стойност
  // от request body-то (брифа т.6: "Не позволявай anonymous client-provided
  // reporter profile id").
  const result = topicModerationStore.createReport({
    topicId,
    reporterProfileId: auth.profileId,
    reason,
  })

  if (!result.ok) {
    sendJsonResponse(res, 409, { ok: false, code: 'topic_report_duplicate', message: 'Вече докладва тази тема наскоро.' })
    return true
  }

  sendJsonResponse(res, 200, { ok: true, reportId: result.report.reportId })
  return true
}

async function handleTopicReportsListRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  requestUrl: URL,
): Promise<boolean> {
  if (pathname !== '/api/admin/topic-reports' || req.method !== 'GET') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isTopicModeratorSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
    return true
  }

  const statusParam = requestUrl.searchParams.get('status')
  const status = statusParam === 'pending' || statusParam === 'reviewed' || statusParam === 'dismissed' ? statusParam : null

  sendJsonResponse(res, 200, {
    ok: true,
    reports: topicModerationStore.listReports(status, 100),
    pendingCount: topicModerationStore.countPendingReports(),
  })
  return true
}

async function handleTopicReportReviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/admin\/topic-reports\/([^/]+)\/review$/.exec(pathname)
  if (!match || req.method !== 'POST') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isTopicModeratorSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
    return true
  }

  const reportId = decodeURIComponent(match[1] ?? '')

  let body: unknown
  try {
    body = await readJsonRequestBody(req)
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидна заявка.' })
    return true
  }
  const rawStatus = (body as { status?: unknown }).status
  if (rawStatus !== 'reviewed' && rawStatus !== 'dismissed') {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден статус.' })
    return true
  }

  const result = topicModerationStore.reviewReport({
    reportId,
    status: rawStatus,
    actorAccountId: session.account.accountId,
  })

  if (!result.ok) {
    sendJsonResponse(res, 404, { ok: false, message: 'Докладът не беше намерен.' })
    return true
  }

  sendJsonResponse(res, 200, { ok: true, report: result.report })
  return true
}

async function handleTopicModerationAuditLogRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/admin\/topics\/([^/]+)\/moderation-log$/.exec(pathname)
  if (!match || req.method !== 'GET') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isTopicModeratorSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
    return true
  }

  const topicId = decodeURIComponent(match[1] ?? '')
  sendJsonResponse(res, 200, {
    ok: true,
    entries: topicModerationStore.listAuditLogForTopic(topicId, 100),
  })
  return true
}

// ─── Tournaments: list / create / details ──────────────────────────────────

const TOURNAMENT_CREATE_RATE_LIMIT_WINDOW_MS = 60_000
const TOURNAMENT_CREATE_RATE_LIMIT_MAX_PER_WINDOW = 3
const tournamentCreateRateLimitByProfileId = new Map<string, { count: number; windowStartedAt: number }>()

function isTournamentCreateRateLimited(profileId: string, now: number): boolean {
  const existing = tournamentCreateRateLimitByProfileId.get(profileId)
  if (existing === undefined || now - existing.windowStartedAt >= TOURNAMENT_CREATE_RATE_LIMIT_WINDOW_MS) {
    tournamentCreateRateLimitByProfileId.set(profileId, { count: 1, windowStartedAt: now })
    return false
  }
  if (existing.count >= TOURNAMENT_CREATE_RATE_LIMIT_MAX_PER_WINDOW) {
    return true
  }
  existing.count += 1
  return false
}

function requireRegisteredHumanSession(
  req: IncomingMessage,
): { ok: true; profileId: string } | { ok: false } {
  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)
  if (session === null || session.profile.profileId === null) {
    return { ok: false }
  }
  return { ok: true, profileId: session.profile.profileId }
}

// ─── Tournaments: beta access gate ─────────────────────────────────────────
// Server-authoritative password gate за секцията "Турнири" по време на
// beta период (виж tournamentBetaAccessStore.ts за DB design). Защитава
// само HUMAN-facing HTTP/WS entry points — вика се explicit от всеки такъв
// route/handler по-долу (requireTournamentBetaAccessOrRespond за HTTP,
// hasTournamentBetaAccessForWsCommand за WS). Умишлено НЕ се вика от
// tournamentCoordinator/tournamentScheduler/settlement/auto-transition
// пътищата — те работят чисто на DB ниво без profile-authenticated request
// context, затова automatically са изолирани от този gate без нужда от
// отделен bypass флаг.

function isTournamentBetaAdminBypassProfile(profileId: string | null): boolean {
  if (profileId === null) return false
  return authStore.getAccountRoleForProfile(profileId) === 'admin'
}

function hasTournamentBetaAccessForProfile(profileId: string | null): boolean {
  if (isTournamentBetaAdminBypassProfile(profileId)) return true
  return tournamentBetaAccessStore.hasAccess(profileId)
}

// За GET-style/optional-auth routes (списък/детайли), извиквани и от
// anonymous visitors — anonymous виждане на public tournament данни не е
// blocked от beta gate-а (само действия, изискващи regisтrиран профил, го
// прилагат чрез requireTournamentBetaAccessOrRespond по-долу). Тук просто
// връщаме дали ТОЗИ конкретен профил (ако има) в момента има достъп, за
// клиентска UI логика (viewer state), без сама по себе си да отказва GET.

// Централен reusable helper за всички REQUIRE-auth tournament action routes
// (join/leave/cancel/create/partner-*/acknowledge/и т.н.) — праща 403 с
// machine-readable reason='beta_access_required', за да може клиентът да
// отвори password modal-а вместо generic error text (виж task spec API
// "Когато API върне beta-access denial, client трябва да може да отвори
// password modal"). Извиква се СЛЕД auth session resolution (нужен е
// profileId), но ПРЕДИ каквато и да е tournament action логика.
function requireTournamentBetaAccessOrRespond(
  res: ServerResponse,
  profileId: string | null,
): boolean {
  if (hasTournamentBetaAccessForProfile(profileId)) return true
  sendJsonResponse(res, 403, {
    ok: false,
    reason: 'beta_access_required',
    message: 'Секцията „Турнири" е в тестов период.',
  })
  return false
}

// Rate limit за password submit опити — отделен от
// TOURNAMENT_ENTRY_ACTION_RATE_LIMIT (join/leave/cancel), по-строг прозорец
// заради brute-force риска специфично за password guessing.
const TOURNAMENT_BETA_PASSWORD_RATE_LIMIT_WINDOW_MS = 60_000
const TOURNAMENT_BETA_PASSWORD_RATE_LIMIT_MAX_PER_WINDOW = 5
const tournamentBetaPasswordRateLimitByProfileId = new Map<string, { count: number; windowStartedAt: number }>()

function isTournamentBetaPasswordRateLimited(profileId: string, now: number): boolean {
  const existing = tournamentBetaPasswordRateLimitByProfileId.get(profileId)
  if (
    existing === undefined ||
    now - existing.windowStartedAt >= TOURNAMENT_BETA_PASSWORD_RATE_LIMIT_WINDOW_MS
  ) {
    tournamentBetaPasswordRateLimitByProfileId.set(profileId, { count: 1, windowStartedAt: now })
    return false
  }
  if (existing.count >= TOURNAMENT_BETA_PASSWORD_RATE_LIMIT_MAX_PER_WINDOW) {
    return true
  }
  existing.count += 1
  return false
}

// GET /api/tournaments/beta-access — public safe info (никога hash/version/
// grants count, виж task spec "НИКОГА не връщай password hash"). enabled=
// false означава gate-ът изобщо не е активен (hasAccess винаги true в тоя
// случай); anonymous viewer (без session) получава hasAccess:false, ако
// gate-ът е enabled.
//
// POST /api/tournaments/beta-access — submit парола, изисква registered
// human session (grant е profile-specific, виж task spec "grant е profile-
// specific"). При правилна парола записва/обновява grant за profileId.
async function handleTournamentBetaAccessRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/tournaments/beta-access') return false

  if (req.method === 'GET') {
    const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
    const session = authStore.getSession(sessionToken)
    const viewerProfileId = session?.profile.profileId ?? null
    if (isTournamentBetaAdminBypassProfile(viewerProfileId)) {
      sendJsonResponse(res, 200, { ok: true, enabled: tournamentBetaAccessStore.getStatus().enabled, hasAccess: true })
      return true
    }
    const info = tournamentBetaAccessStore.getPublicInfo(viewerProfileId)
    sendJsonResponse(res, 200, { ok: true, enabled: info.enabled, hasAccess: info.hasAccess })
    return true
  }

  if (req.method === 'POST') {
    if (!isAllowedVisitorRequestOrigin(req)) {
      sendJsonResponse(res, 403, { ok: false, message: 'Заявката е отхвърлена.' })
      return true
    }

    const authResult = requireRegisteredHumanSession(req)
    if (!authResult.ok) {
      sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
      return true
    }
    const { profileId } = authResult

    if (isTournamentBetaPasswordRateLimited(profileId, Date.now())) {
      sendJsonResponse(res, 429, { ok: false, message: 'Твърде много опити. Опитай отново след малко.' })
      return true
    }

    let body: unknown
    try {
      body = await readJsonRequestBody(req)
    } catch {
      sendJsonResponse(res, 400, { ok: false, reason: 'invalid_password', message: 'Невалидна заявка.' })
      return true
    }
    if (!isRecord(body) || typeof body.password !== 'string') {
      sendJsonResponse(res, 400, { ok: false, reason: 'invalid_password', message: 'Невалидна парола за достъп.' })
      return true
    }

    const result = tournamentBetaAccessStore.submitPassword(profileId, body.password)
    if (!result.ok) {
      const status = result.reason === 'not_enabled' || result.reason === 'no_password_configured' ? 409 : 401
      const message = result.reason === 'not_enabled'
        ? 'Секцията вече не изисква парола.'
        : result.reason === 'no_password_configured'
          ? 'Достъпът все още не е конфигуриран.'
          : 'Невалидна парола за достъп.'
      sendJsonResponse(res, status, { ok: false, reason: result.reason, message })
      return true
    }

    sendJsonResponse(res, 200, { ok: true })
    return true
  }

  sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
  return true
}

function getTournamentCreatorPublicProfile(
  creatorProfileId: string,
): { profileId: string | null; displayName: string; avatarUrl: string | null } | null {
  const publicProfile = playerProgressStore.getPublicProfile(creatorProfileId)
  if (publicProfile === null) return null
  return {
    profileId: publicProfile.profileId,
    displayName: publicProfile.displayName,
    avatarUrl: publicProfile.avatarUrl,
  }
}

function buildTournamentSummaryDto(
  tournament: TournamentRecord,
  viewerProfileId: string | null,
): TournamentSummaryDto {
  tournamentEconomyStore.expireDuePartnerInvitesAtomically(tournament.tournamentId)
  const entries = tournamentStore.getEntriesForTournament(tournament.tournamentId)
  const teams = tournamentStore.getTeamsForTournament(tournament.tournamentId)
  const viewerEntry = viewerProfileId !== null
    ? entries.find((e) => e.profileId === viewerProfileId) ?? null
    : null
  const reservedPlacesCount = tournamentEconomyStore.countReservedPendingPlaces(
    tournament.tournamentId,
  )
  return toTournamentSummaryDto({
    tournament,
    creatorPublicProfile: getTournamentCreatorPublicProfile(tournament.creatorProfileId),
    confirmedEntriesCount: entries.filter((e) => isTournamentRosterEntryStatus(e.status)).length,
    reservedPlacesCount,
    completedTeamsCount: teams.filter((t) => t.status !== 'forming').length,
    formingTeamsCount: teams.filter((t) => t.status === 'forming').length,
    viewerProfileId,
    viewerEntryStatus: viewerEntry?.status ?? null,
    viewerEntryJoinedAs: viewerEntry?.joinedAs ?? null,
  })
}

function isTournamentRosterEntryStatus(status: TournamentEntryStatus): boolean {
  return status === 'confirmed' || status === 'finalist' || status === 'champion' || status === 'eliminated'
}

function getSafePublicProfile(profileId: string): { profileId: string | null; displayName: string; avatarUrl: string | null } | null {
  const profile = playerProgressStore.getPublicProfile(profileId)
  if (profile === null) return null
  return { profileId: profile.profileId, displayName: profile.displayName, avatarUrl: profile.avatarUrl }
}

function isBotProfile(profileId: string): boolean {
  return playerProgressStore.getPublicProfile(profileId)?.isBot === true
}

function buildTournamentPartnerInviteDto(invite: TournamentPartnerInviteRecord) {
  return toTournamentPartnerInviteDto({
    invite,
    inviterPublicProfile: getSafePublicProfile(invite.inviterProfileId),
    inviteePublicProfile: getSafePublicProfile(invite.inviteeProfileId),
    tournament: tournamentStore.getTournamentById(invite.tournamentId),
  })
}

function sendTournamentPartnerInviteResolved(invite: {
  inviteId: string
  tournamentId: string
  inviteeProfileId: string
  inviterProfileId: string
  status: string
}): void {
  const payload = {
    type: 'tournament_partner_invite_resolved',
    inviteId: invite.inviteId,
    tournamentId: invite.tournamentId,
    status: invite.status,
  }
  sendToOpenProfileConnections(invite.inviteeProfileId, payload)
  sendToOpenProfileConnections(invite.inviterProfileId, payload)
}

function buildTournamentDetailDto(tournament: TournamentRecord, viewerProfileId: string | null) {
  tournamentEconomyStore.expireDuePartnerInvitesAtomically(tournament.tournamentId)
  const entries = tournamentStore.getEntriesForTournament(tournament.tournamentId)
  const teams = tournamentStore.getTeamsForTournament(tournament.tournamentId)
  const rounds = tournamentStore.getRoundsForTournament(tournament.tournamentId)
  const matches = tournamentStore.getMatchesForTournament(tournament.tournamentId)
  const viewerEntry = viewerProfileId !== null
    ? entries.find((e) => e.profileId === viewerProfileId) ?? null
    : null
  const reservedPlacesCount = tournamentEconomyStore.countReservedPendingPlaces(
    tournament.tournamentId,
  )
  const teamDtos = buildTeamDtos({
    teams,
    entries,
    getPublicProfile: getSafePublicProfile,
  })
  const roundDtos = buildTournamentRoundDtos({
    rounds,
    matches,
    getLiveScoreForRoom: (roomId) => {
      const room = serverState.rooms[roomId] ?? null
      const authState = room?.game.authoritativeState ?? null
      if (authState === null || 'kind' in authState || authState.matchEnded !== null) {
        return null
      }
      return { teamA: authState.score.match.teamA, teamB: authState.score.match.teamB }
    },
  })
  const pendingInvites = viewerProfileId !== null
    ? tournamentEconomyStore.listPendingPartnerInvitesForProfile(viewerProfileId)
    : []
  const incomingPartnerInvite = pendingInvites.find((i) => i.tournamentId === tournament.tournamentId) ?? null
  const outgoingPartnerInvite = viewerProfileId !== null
    ? tournamentEconomyStore.getOutgoingPendingInviteForProfile(tournament.tournamentId, viewerProfileId)
    : null
  const base = toTournamentDetailDto({
    tournament,
    creatorPublicProfile: getTournamentCreatorPublicProfile(tournament.creatorProfileId),
    confirmedEntriesCount: entries.filter((e) => isTournamentRosterEntryStatus(e.status)).length,
    reservedPlacesCount,
    completedTeamsCount: teams.filter((t) => t.status !== 'forming').length,
    formingTeamsCount: teams.filter((t) => t.status === 'forming').length,
    viewerProfileId,
    viewerEntryStatus: viewerEntry?.status ?? null,
    viewerEntryJoinedAs: viewerEntry?.joinedAs ?? null,
  })
  const inviteToDto = (invite: NonNullable<typeof incomingPartnerInvite>) => toTournamentPartnerInviteDto({
    invite,
    inviterPublicProfile: getSafePublicProfile(invite.inviterProfileId),
    inviteePublicProfile: getSafePublicProfile(invite.inviteeProfileId),
    tournament,
  })
  const myActiveMatch = viewerProfileId !== null
    ? tournamentCoordinator?.getAssignmentForProfile(viewerProfileId) ?? null
    : null
  // §"КРИТИЧНО РАЗГРАНИЧЕНИЕ" в допълнението — myActiveMatch/myInterRoundWaiting
  // показват КЪДЕ е viewer-ът в турнира, НЕ дали изобщо е бил bot-replaced.
  // Тази отделна проверка е единственото authoritative "force-return
  // requirement" доказателство, което клиентският blocking modal трябва да
  // ползва — виж hasUnresolvedBotReplacement в tournamentCoordinator.ts.
  const viewerHasUnresolvedBotReplacement = viewerProfileId !== null
    ? tournamentCoordinator?.hasUnresolvedBotReplacement(tournament.tournamentId, viewerProfileId) ?? false
    : false
  // Generic across every round transition (round_of_16->quarterfinal,
  // quarterfinal->semifinal, semifinal->final) — task spec §5. Walks the
  // team-capacity ladder instead of hardcoding 'semifinal'/'final', finding
  // whichever round the viewer's team most recently won and hasn't yet
  // advanced past. hasSemifinalResultAcknowledgement is still read/written
  // for the semifinal->final transition specifically (idempotent evidence
  // only, per task spec §4 — never gates anything here); for any other
  // transition ownResultAcknowledged/otherFinalistReady are simply reported
  // as true/not-applicable since no ack step exists for those transitions
  // and none is being added (task spec: "НЕ generalize-вай manual ack към
  // R16/QF").
  const buildMyInterRoundWaiting = () => {
    if (viewerProfileId === null || viewerEntry?.teamId === null || viewerEntry?.teamId === undefined) return null
    if (tournament.status === 'finished' || myActiveMatch !== null) return null
    if (
      viewerEntry.status !== 'confirmed' &&
      viewerEntry.status !== 'finalist' &&
      viewerEntry.status !== 'champion'
    ) {
      return null
    }

    const teamCapacity = tournament.playerCapacity / 2
    const ladder = getTournamentRoundLadder(teamCapacity)

    for (let ladderIndex = 0; ladderIndex < ladder.length - 1; ladderIndex += 1) {
      const currentRoundType = ladder[ladderIndex] as TournamentRoundType
      const nextRoundType = ladder[ladderIndex + 1] as TournamentRoundType

      const currentRoundMatches = roundDtos
        .filter((round) => round.roundType === currentRoundType)
        .flatMap((round) => round.matches.map((match) => ({ roundIndex: round.roundIndex, match })))
        .sort((a, b) => a.roundIndex - b.roundIndex)
      const completedEntry = currentRoundMatches.find(({ match }) => {
        return match.status === 'completed' &&
          match.winnerTeamId === viewerEntry.teamId &&
          (match.teamAId === viewerEntry.teamId || match.teamBId === viewerEntry.teamId)
      })
      if (completedEntry === undefined) continue
      const completedMatch = completedEntry.match

      const completedIndex = currentRoundMatches.findIndex(({ match }) => match.matchId === completedMatch.matchId)
      const siblingEntry = completedIndex >= 0
        ? currentRoundMatches[completedIndex % 2 === 0 ? completedIndex + 1 : completedIndex - 1]
        : undefined
      if (siblingEntry === undefined) continue
      const sibling = siblingEntry.match
      const siblingTeamA = teamDtos.find((team) => team.teamId === sibling.teamAId) ?? null
      const siblingTeamB = teamDtos.find((team) => team.teamId === sibling.teamBId) ?? null
      if (siblingTeamA === null || siblingTeamB === null) continue

      const nextMatch = roundDtos
        .find((round) => round.roundType === nextRoundType)
        ?.matches.find((match) => match.teamAId === viewerEntry.teamId || match.teamBId === viewerEntry.teamId)
        ?? null
      // The next round's match for this team already exists AND has moved
      // past pure waiting (players seated/playing/done) — this team has
      // already progressed beyond the unified waiting popup for this
      // transition, so keep walking the ladder in case they've since won
      // ANOTHER round past this one (shouldn't normally happen given
      // myActiveMatch is checked above, but keeps the loop well-defined).
      if (nextMatch !== null && (nextMatch.status === 'countdown' || nextMatch.status === 'in_progress' || nextMatch.status === 'completed')) {
        continue
      }

      const isSemifinalToFinal = currentRoundType === 'semifinal' && nextRoundType === 'final'
      const ownResultAcknowledged = isSemifinalToFinal
        ? tournamentStore.hasSemifinalResultAcknowledgement(tournament.tournamentId, completedMatch.matchId, viewerProfileId)
        : true
      const otherTeamId = nextMatch !== null
        ? nextMatch.teamAId === viewerEntry.teamId ? nextMatch.teamBId : nextMatch.teamAId
        : sibling.winnerTeamId
      const otherTeamEntries = otherTeamId !== null
        ? entries.filter((entry) => entry.teamId === otherTeamId && (entry.status === 'confirmed' || entry.status === 'finalist'))
        : []
      const otherHumanTeamEntries = otherTeamEntries.filter((entry) => !isBotProfile(entry.profileId))
      const otherFinalistReady = !isSemifinalToFinal
        ? sibling.status === 'completed'
        : sibling.status === 'completed' &&
          otherTeamId !== null &&
          otherHumanTeamEntries.every((entry) => {
            const wonRound = currentRoundMatches.find(({ match }) => {
              return match.status === 'completed' && match.winnerTeamId === entry.teamId
            })?.match
            return wonRound !== undefined &&
              tournamentStore.hasSemifinalResultAcknowledgement(tournament.tournamentId, wonRound.matchId, entry.profileId)
          })

      const siblingDto = {
        matchId: sibling.matchId,
        roundIndex: siblingEntry.roundIndex,
        teamA: siblingTeamA,
        teamB: siblingTeamB,
        scoreA: sibling.finalScoreTeamA ?? sibling.liveScoreTeamA ?? null,
        scoreB: sibling.finalScoreTeamB ?? sibling.liveScoreTeamB ?? null,
        status: sibling.status,
        winnerTeamId: sibling.winnerTeamId,
        progressLabel: sibling.progressLabel ?? '',
      }

      return {
        tournamentId: tournament.tournamentId,
        currentRoundType,
        nextRoundType,
        completedMatchId: completedMatch.matchId,
        sibling: siblingDto,
        ownResultAcknowledged,
        otherFinalistReady,
        nextMatchId: nextMatch?.matchId ?? null,
        nextRoomId: nextMatch?.roomId ?? null,
        nextMatchStartAt: nextMatch?.nextMatchStartAt ?? null,
        serverNow: new Date().toISOString(),
        // legacy aliases (Phase 1 backward compat, see
        // TournamentInterRoundWaitingDto comment) — same values as above.
        completedSemifinalMatchId: completedMatch.matchId,
        siblingSemifinal: siblingDto,
        finalMatchId: nextMatch?.matchId ?? null,
        finalRoomId: nextMatch?.roomId ?? null,
        finalStartAt: nextMatch?.nextMatchStartAt ?? null,
      }
    }

    return null
  }
  return {
    ...base,
    teams: teamDtos,
    myTeam: viewerEntry?.teamId ? teamDtos.find((team) => team.teamId === viewerEntry.teamId) ?? null : null,
    rounds: roundDtos,
    myActiveMatch,
    myInterRoundWaiting: buildMyInterRoundWaiting(),
    incomingPartnerInvite: incomingPartnerInvite ? inviteToDto(incomingPartnerInvite) : null,
    outgoingPartnerInvite: outgoingPartnerInvite ? inviteToDto(outgoingPartnerInvite) : null,
    viewerHasUnresolvedBotReplacement,
  }
}

async function handleTournamentsListRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  requestUrl: URL,
): Promise<boolean> {
  if (pathname !== '/api/tournaments') return false

  if (req.method === 'GET') {
    const mineParam = requestUrl.searchParams.get('mine') === 'true'
    const rawPage = Number(requestUrl.searchParams.get('page') ?? '1')
    const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1
    const limit = 20
    const offset = (page - 1) * limit

    let viewerProfileId: string | null = null
    if (mineParam) {
      const authResult = requireRegisteredHumanSession(req)
      if (!authResult.ok) {
        sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
        return true
      }
      viewerProfileId = authResult.profileId
    } else {
      const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
      const session = authStore.getSession(sessionToken)
      viewerProfileId = session?.profile.profileId ?? null
    }

    if (!requireTournamentBetaAccessOrRespond(res, viewerProfileId)) {
      return true
    }

    const tournaments = mineParam
      ? tournamentStore.listTournaments({ creatorProfileId: viewerProfileId ?? undefined, limit, offset })
      : [
          ...tournamentStore.listTournaments({
            statuses: ACTIVE_TOURNAMENT_STATUSES,
            limit: 50,
            offset: 0,
            orderBy: 'created_desc',
          }),
          ...tournamentStore.listTournaments({
            statuses: ['finished'],
            limit: 10,
            offset: 0,
            orderBy: 'finished_desc',
          }),
        ]
    const totalCount = mineParam
      ? tournamentStore.countTournaments({ creatorProfileId: viewerProfileId ?? undefined })
      : tournamentStore.countTournaments({ statuses: ACTIVE_TOURNAMENT_STATUSES }) +
        Math.min(10, tournamentStore.countTournaments({ statuses: ['finished'] }))

    sendJsonResponse(res, 200, {
      ok: true,
      tournaments: tournaments.map((t) => buildTournamentSummaryDto(t, viewerProfileId)),
      page,
      limit,
      totalCount,
    })
    return true
  }

  if (req.method === 'POST') {
    const authResult = requireRegisteredHumanSession(req)
    if (!authResult.ok) {
      sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си, за да създадеш турнир.' })
      return true
    }
    const { profileId } = authResult

    if (!requireTournamentBetaAccessOrRespond(res, profileId)) {
      return true
    }

    if (isTournamentCreateRateLimited(profileId, Date.now())) {
      sendJsonResponse(res, 429, { ok: false, message: 'Твърде много опити. Опитай отново след малко.' })
      return true
    }

    let body: unknown
    try {
      body = await readJsonRequestBody(req)
    } catch {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалидно JSON тяло.' })
      return true
    }

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалидна заявка.' })
      return true
    }

    const nameValidation = validateTournamentName(getStringField(body, 'name'))
    if (!nameValidation.ok) {
      const messages: Record<typeof nameValidation.code, string> = {
        empty: 'Името на турнира е задължително.',
        too_short: 'Името на турнира трябва да е поне 3 символа.',
        too_long: 'Името на турнира трябва да е максимум 40 символа.',
        invalid_characters: 'Името на турнира съдържа непозволени символи.',
      }
      sendJsonResponse(res, 400, { ok: false, message: messages[nameValidation.code] })
      return true
    }

    const rawEntryFee = getNumberField(body, 'entryFee')
    if (rawEntryFee === null || !isAllowedTournamentEntryFee(rawEntryFee)) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: `Входът трябва да е една от стойностите: ${ALLOWED_TOURNAMENT_ENTRY_FEES.join(', ')}.`,
      })
      return true
    }

    // teamCapacity е единственото поле, което клиентът подава за размера на
    // турнира — playerCapacity НИКОГА не се приема от client payload-а
    // (server-authoritative: playerCapacity = teamCapacity * 2, виж createTournament).
    // Ако полето липсва, по подразбиране е 4 отбора (запазва старото поведение).
    const rawTeamCapacityField = body.teamCapacity
    const rawTeamCapacity = rawTeamCapacityField === undefined
      ? 4
      : getNumberField(body, 'teamCapacity')
    if (rawTeamCapacity === null || !isAllowedTournamentTeamCapacity(rawTeamCapacity)) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: `Броят отбори трябва да е една от стойностите: ${ALLOWED_TOURNAMENT_TEAM_CAPACITIES.join(', ')}.`,
      })
      return true
    }
    if ('playerCapacity' in body) {
      // Explicit защита срещу client payload, който се опитва да подаде
      // playerCapacity директно (напр. несъответстващи 4 отбора и 32 играчи).
      sendJsonResponse(res, 400, { ok: false, message: 'Броят играчи се изчислява автоматично от броя отбори.' })
      return true
    }

    const rawVisibility = getStringField(body, 'visibility')
    if (!isValidTournamentVisibility(rawVisibility)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалидна видимост на турнира.' })
      return true
    }

    const rawStartMode = getStringField(body, 'startMode')
    if (!isValidTournamentStartMode(rawStartMode)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалиден режим на стартиране.' })
      return true
    }

    let passwordHash: string | null = null
    if (rawVisibility === 'password') {
      const rawPassword = getStringField(body, 'password')
      const passwordValidation = validateTournamentPassword(rawPassword)
      if (!passwordValidation.ok) {
        const messages: Record<typeof passwordValidation.code, string> = {
          too_short: `Паролата трябва да е поне 4 знака.`,
          too_long: `Паролата трябва да е максимум 32 знака.`,
        }
        sendJsonResponse(res, 400, { ok: false, message: messages[passwordValidation.code] })
        return true
      }
      passwordHash = createPasswordHash(passwordValidation.password)
    } else if ('password' in body && getStringField(body, 'password') !== '') {
      // Public турнир не трябва да носи парола — отхвърляме explicit, вместо
      // тихо да игнорираме потенциално подведащ вход от клиента.
      sendJsonResponse(res, 400, { ok: false, message: 'Публичен турнир не може да има парола.' })
      return true
    }

    let scheduledStartAt: string | null = null
    if (rawStartMode === 'scheduled') {
      const rawScheduledStartAt = getStringField(body, 'scheduledStartAt')
      const scheduledValidation = validateTournamentScheduledStartAt(rawScheduledStartAt)
      if (!scheduledValidation.ok) {
        const messages: Record<typeof scheduledValidation.code, string> = {
          invalid_timestamp: 'Невалидна дата и час за стартиране.',
          too_soon: 'Стартът трябва да е поне 30 минути напред.',
          too_late: 'Стартът трябва да е най-много 7 дни напред.',
        }
        sendJsonResponse(res, 400, { ok: false, message: messages[scheduledValidation.code] })
        return true
      }
      scheduledStartAt = scheduledValidation.scheduledStartAt
    } else if ('scheduledStartAt' in body && getStringField(body, 'scheduledStartAt') !== '') {
      sendJsonResponse(res, 400, { ok: false, message: 'Турнир "при запълване" не може да има зададен час.' })
      return true
    }

    const createResult = tournamentStore.createTournament({
      kind: 'community',
      name: nameValidation.name,
      creatorProfileId: profileId,
      visibility: rawVisibility,
      passwordHash,
      entryFee: rawEntryFee,
      playerCapacity: rawTeamCapacity * 2,
      startMode: rawStartMode,
      scheduledStartAt,
    })

    if (!createResult.ok) {
      sendJsonResponse(res, 409, {
        ok: false,
        message: 'Вече имаш активен турнир. Изчакай той да приключи или го отмени, преди да създадеш нов.',
      })
      return true
    }

    tournamentStore.appendTournamentEvent({
      tournamentId: createResult.tournament.tournamentId,
      eventType: 'tournament_created',
      actorProfileId: profileId,
      actorRole: 'player',
    })

    sendJsonResponse(res, 200, {
      ok: true,
      tournament: buildTournamentSummaryDto(createResult.tournament, profileId),
    })
    return true
  }

  sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
  return true
}

async function handleTournamentDetailRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/tournaments\/([^/]+)$/.exec(pathname)
  if (!match) return false

  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  let tournamentId: string
  try {
    tournamentId = decodeURIComponent(match[1] ?? '')
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден идентификатор на турнир.' })
    return true
  }
  if (!tournamentId) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден идентификатор на турнир.' })
    return true
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)
  const viewerProfileId = session?.profile.profileId ?? null

  if (!requireTournamentBetaAccessOrRespond(res, viewerProfileId)) {
    return true
  }

  const tournament = tournamentStore.getTournamentById(tournamentId)
  if (tournament === null) {
    sendJsonResponse(res, 404, { ok: false, message: 'Турнирът не е намерен.' })
    return true
  }

  const isCreator = viewerProfileId !== null && viewerProfileId === tournament.creatorProfileId
  const hasPendingInviteAccess = viewerProfileId !== null &&
    tournamentEconomyStore
      .listPendingPartnerInvitesForProfile(viewerProfileId)
      .some((invite) => invite.tournamentId === tournament.tournamentId)
  const isParticipantForAccess = viewerProfileId !== null &&
    tournamentStore
      .getEntriesForTournament(tournament.tournamentId)
      .some((entry) => entry.profileId === viewerProfileId && entry.status === 'confirmed')

  if (tournament.visibility === 'password' && !isCreator && !hasPendingInviteAccess && !isParticipantForAccess) {
    // POST /api/tournaments/:id с {password} служи като unlock проверка;
    // GET (или POST без валидна парола) никога не разкрива детайлите.
    let providedPassword: string | null = null
    if (req.method === 'POST') {
      let body: unknown
      try {
        body = await readJsonRequestBody(req)
      } catch {
        sendJsonResponse(res, 400, { ok: false, message: 'Невалидно JSON тяло.' })
        return true
      }
      if (isRecord(body) && typeof body.password === 'string') {
        providedPassword = body.password
      }
    }

    const passwordMatches =
      providedPassword !== null &&
      tournament.passwordHash !== null &&
      verifyPassword(providedPassword, tournament.passwordHash)

    if (!passwordMatches) {
      sendJsonResponse(res, 403, {
        ok: false,
        message: providedPassword === null
          ? 'Този турнир е защитен с парола.'
          : 'Грешна парола.',
        requiresPassword: true,
      })
      return true
    }
  }

  sendJsonResponse(res, 200, {
    ok: true,
    tournament: buildTournamentDetailDto(tournament, viewerProfileId),
  })
  return true
}

// ─── Tournaments: join / leave / cancel (entry fee escrow) ────────────────

const TOURNAMENT_ENTRY_ACTION_RATE_LIMIT_WINDOW_MS = 60_000
const TOURNAMENT_ENTRY_ACTION_RATE_LIMIT_MAX_PER_WINDOW = 5
const tournamentEntryActionRateLimitByProfileId = new Map<string, { count: number; windowStartedAt: number }>()

function isTournamentEntryActionRateLimited(profileId: string, now: number): boolean {
  const existing = tournamentEntryActionRateLimitByProfileId.get(profileId)
  if (
    existing === undefined ||
    now - existing.windowStartedAt >= TOURNAMENT_ENTRY_ACTION_RATE_LIMIT_WINDOW_MS
  ) {
    tournamentEntryActionRateLimitByProfileId.set(profileId, { count: 1, windowStartedAt: now })
    return false
  }
  if (existing.count >= TOURNAMENT_ENTRY_ACTION_RATE_LIMIT_MAX_PER_WINDOW) {
    return true
  }
  existing.count += 1
  return false
}

const JOIN_FAILURE_MESSAGES: Record<string, string> = {
  tournament_not_found: 'Турнирът не е намерен.',
  tournament_not_open: 'Турнирът вече не приема записвания.',
  tournament_fill_expired: 'Срокът за запълване на турнира изтече.',
  tournament_full: 'Турнирът е запълнен.',
  rejoin_not_allowed: 'Вече си напускал този турнир и не можеш да се запишеш повторно.',
  already_participating_elsewhere: 'Вече участваш в друг активен турнир.',
  insufficient_funds: 'Нямаш достатъчно жълтици за този вход.',
  requires_password: 'Този турнир е защитен с парола.',
}

const PARTNER_INVITE_FAILURE_MESSAGES: Record<string, string> = {
  tournament_not_found: 'Турнирът не е намерен.',
  tournament_not_open: 'Турнирът вече не приема записвания.',
  tournament_fill_expired: 'Турнирът вече е отменен, защото не се запълни навреме.',
  tournament_full: 'Няма достатъчно свободни места.',
  invite_window_closed: 'Прозорецът за покани е затворен.',
  requires_password: 'Този турнир е защитен с парола.',
  not_friend: 'Можеш да поканиш само потвърден приятел.',
  blocked: 'Не можеш да поканиш този приятел заради блокиране.',
  invalid_invitee: 'Избраният профил не може да бъде поканен.',
  self_invite: 'Не можеш да поканиш себе си.',
  already_participant: 'Този играч вече участва в турнира.',
  already_participating_elsewhere: 'Играчът вече има активно турнирно участие.',
  already_has_pending_invite: 'Вече има активна покана.',
  already_teamed: 'Вече участваш в отбор.',
  invite_not_found: 'Поканата не е намерена.',
  not_invitee: 'Само поканеният може да приеме или откаже поканата.',
  not_inviter: 'Само поканилият може да отмени поканата.',
  invite_not_pending: 'Поканата вече е обработена.',
  insufficient_funds: 'Нямаш достатъчно жълтици за входа.',
  team_invalid: 'Отборът вече не е валиден.',
}

function getPartnerInviteFailureStatus(reason: string): number {
  if (reason === 'tournament_not_found' || reason === 'invite_not_found') return 404
  if (reason === 'requires_password' || reason === 'not_invitee' || reason === 'not_inviter') return 403
  if (reason === 'insufficient_funds') return 402
  return 409
}

function isProfileOnline(profileId: string): boolean {
  for (const connection of Object.values(serverState.connections)) {
    if (connection.profileId === profileId) return true
  }
  return false
}

async function handleTournamentPartnerCandidatesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/tournaments\/([^/]+)\/partner-candidates$/.exec(pathname)
  if (!match) return false
  if (req.method !== 'GET') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }
  const authResult = requireRegisteredHumanSession(req)
  if (!authResult.ok) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }
  if (!requireTournamentBetaAccessOrRespond(res, authResult.profileId)) {
    return true
  }
  const tournamentId = decodeURIComponent(match[1] ?? '')
  const candidates: TournamentPartnerCandidateDto[] = tournamentEconomyStore
    .getPartnerCandidatesForTournament(tournamentId, authResult.profileId)
    .map((candidate) => ({
      profileId: candidate.profileId,
      displayName: candidate.displayName,
      avatarUrl: candidate.avatarUrl,
      online: isProfileOnline(candidate.profileId),
      eligible: candidate.eligible,
      unavailableReason: candidate.unavailableReason,
    }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName, 'bg'))
  sendJsonResponse(res, 200, { ok: true, candidates })
  return true
}

const TOURNAMENT_PARTNER_SEARCH_MIN_QUERY_LENGTH = 2
const TOURNAMENT_PARTNER_SEARCH_MAX_RAW_QUERY_LENGTH = 64
const TOURNAMENT_PARTNER_SEARCH_TOO_SHORT_MESSAGE = 'Въведи поне 2 символа за търсене.'

// Global partner search (§ "GLOBAL SEARCH AREA") — отделен endpoint от
// handleTournamentPartnerCandidatesRequest (friends list) по същия query-based
// pattern като handlePlayersSearchRequest (GET /api/players/search): НЕ връща
// цялата user база, min-length guard-ва празни/твърде кратки заявки, reuse-ва
// normalizeProfileSearchTerm за bg-BG case-insensitive/Cyrillic normalization.
// Response DTO shape-ът е ИДЕНТИЧЕН на handleTournamentPartnerCandidatesRequest
// (TournamentPartnerCandidateDto[]), за да може клиентът да reuse-ва точно
// същия render/click/invite код за резултатите от двата source-а.
async function handleTournamentPartnerCandidatesSearchRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  requestUrl: URL,
): Promise<boolean> {
  const match = /^\/api\/tournaments\/([^/]+)\/partner-candidates\/search$/.exec(pathname)
  if (!match) return false
  if (req.method !== 'GET') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }
  const authResult = requireRegisteredHumanSession(req)
  if (!authResult.ok) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }
  if (!requireTournamentBetaAccessOrRespond(res, authResult.profileId)) {
    return true
  }

  const rawQuery = (requestUrl.searchParams.get('q') ?? '').trim()

  if (rawQuery.length === 0) {
    sendJsonResponse(res, 400, { ok: false, message: TOURNAMENT_PARTNER_SEARCH_TOO_SHORT_MESSAGE })
    return true
  }
  if (rawQuery.length > TOURNAMENT_PARTNER_SEARCH_MAX_RAW_QUERY_LENGTH) {
    sendJsonResponse(res, 400, { ok: false, message: 'Търсенето е твърде дълго.' })
    return true
  }

  const normalizedTerm = normalizeProfileSearchTerm(rawQuery)
  if (normalizedTerm.length < TOURNAMENT_PARTNER_SEARCH_MIN_QUERY_LENGTH) {
    sendJsonResponse(res, 400, { ok: false, message: TOURNAMENT_PARTNER_SEARCH_TOO_SHORT_MESSAGE })
    return true
  }

  const tournamentId = decodeURIComponent(match[1] ?? '')
  const candidates: TournamentPartnerCandidateDto[] = tournamentEconomyStore
    .getGlobalPartnerCandidatesForTournament(tournamentId, authResult.profileId, normalizedTerm)
    .map((candidate) => ({
      profileId: candidate.profileId,
      displayName: candidate.displayName,
      avatarUrl: candidate.avatarUrl,
      online: isProfileOnline(candidate.profileId),
      eligible: candidate.eligible,
      unavailableReason: candidate.unavailableReason,
    }))
  sendJsonResponse(res, 200, { ok: true, candidates })
  return true
}

async function handlePendingTournamentPartnerInvitesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/tournaments/partner-invites/pending') return false
  if (req.method !== 'GET') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }
  const authResult = requireRegisteredHumanSession(req)
  if (!authResult.ok) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }
  if (!requireTournamentBetaAccessOrRespond(res, authResult.profileId)) {
    return true
  }
  const invites = tournamentEconomyStore
    .listPendingPartnerInvitesForProfile(authResult.profileId)
    .map(buildTournamentPartnerInviteDto)
  sendJsonResponse(res, 200, { ok: true, invites })
  return true
}

async function handleTournamentPartnerInviteNotificationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/tournaments\/partner-invites\/([^/]+)\/(dismiss-popup|view)$/.exec(pathname)
  if (!match) return false
  if (req.method !== 'POST') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }
  if (!isAllowedVisitorRequestOrigin(req)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Заявката е отхвърлена.' })
    return true
  }
  const authResult = requireRegisteredHumanSession(req)
  if (!authResult.ok) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }
  if (!requireTournamentBetaAccessOrRespond(res, authResult.profileId)) {
    return true
  }
  if (isTournamentEntryActionRateLimited(authResult.profileId, Date.now())) {
    sendJsonResponse(res, 429, { ok: false, message: 'Твърде много опити. Опитай отново след малко.' })
    return true
  }

  let inviteId: string
  try {
    inviteId = decodeURIComponent(match[1] ?? '')
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидна покана.' })
    return true
  }
  if (!VISITOR_UUID_RE.test(inviteId)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидна покана.' })
    return true
  }

  const action = match[2]
  const result = action === 'view'
    ? tournamentEconomyStore.viewPartnerInviteNotification(inviteId, authResult.profileId)
    : tournamentEconomyStore.dismissPartnerInvitePopup(inviteId, authResult.profileId)

  if (!result.ok) {
    sendJsonResponse(res, getPartnerInviteFailureStatus(result.reason), {
      ok: false,
      reason: result.reason,
      message: PARTNER_INVITE_FAILURE_MESSAGES[result.reason] ?? 'Поканата вече не е активна.',
    })
    return true
  }

  sendToOpenProfileConnections(authResult.profileId, {
    type: 'tournament_partner_invite_popup_dismissed',
    inviteId: result.invite.inviteId,
    tournamentId: result.invite.tournamentId,
    popupDismissedAt: result.invite.popupDismissedAt,
    notificationReadAt: result.invite.notificationReadAt,
  })

  sendJsonResponse(res, 200, {
    ok: true,
    tournamentId: result.invite.tournamentId,
    invite: buildTournamentPartnerInviteDto(result.invite),
  })
  return true
}

async function handleTournamentPartnerInviteCreateRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/tournaments\/([^/]+)\/partner-invites$/.exec(pathname)
  if (!match) return false
  if (req.method !== 'POST') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }
  if (!isAllowedVisitorRequestOrigin(req)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Заявката е отхвърлена.' })
    return true
  }
  const authResult = requireRegisteredHumanSession(req)
  if (!authResult.ok) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }
  if (!requireTournamentBetaAccessOrRespond(res, authResult.profileId)) {
    return true
  }
  if (isTournamentEntryActionRateLimited(authResult.profileId, Date.now())) {
    sendJsonResponse(res, 429, { ok: false, message: 'Твърде много опити. Опитай отново след малко.' })
    return true
  }
  let body: unknown
  try {
    body = await readJsonRequestBody(req)
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидно JSON тяло.' })
    return true
  }
  if (!isRecord(body) || typeof body.inviteeProfileId !== 'string') {
    sendJsonResponse(res, 400, { ok: false, message: 'Избери приятел за партньор.' })
    return true
  }
  const tournamentId = decodeURIComponent(match[1] ?? '')
  const result = tournamentEconomyStore.createPartnerInviteAtomically(
    tournamentId,
    authResult.profileId,
    body.inviteeProfileId,
    { password: typeof body.password === 'string' ? body.password : null },
  )
  if (!result.ok) {
    sendJsonResponse(res, getPartnerInviteFailureStatus(result.reason), {
      ok: false,
      reason: result.reason,
      message: PARTNER_INVITE_FAILURE_MESSAGES[result.reason] ?? 'Поканата не бе изпратена.',
      requiresPassword: result.reason === 'requires_password' ? true : undefined,
    })
    return true
  }
  sendJsonResponse(res, 200, {
    ok: true,
    debitedAmount: result.debitedAmount,
    invite: buildTournamentPartnerInviteDto(result.invite),
    walletBalance: result.walletBalance,
    tournament: buildTournamentSummaryDto(result.tournament, authResult.profileId),
  })
  sendToOpenProfileConnections(result.invite.inviteeProfileId, {
    type: 'tournament_partner_invite_received',
    invite: buildTournamentPartnerInviteDto(result.invite),
  })
  return true
}

async function handleTournamentPartnerInviteActionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/tournaments\/([^/]+)\/partner-invites\/([^/]+)\/(accept|decline|cancel)$/.exec(pathname)
  if (!match) return false
  if (req.method !== 'POST') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }
  if (!isAllowedVisitorRequestOrigin(req)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Заявката е отхвърлена.' })
    return true
  }
  const authResult = requireRegisteredHumanSession(req)
  if (!authResult.ok) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }
  if (!requireTournamentBetaAccessOrRespond(res, authResult.profileId)) {
    return true
  }
  if (isTournamentEntryActionRateLimited(authResult.profileId, Date.now())) {
    sendJsonResponse(res, 429, { ok: false, message: 'Твърде много опити. Опитай отново след малко.' })
    return true
  }
  const tournamentId = decodeURIComponent(match[1] ?? '')
  const inviteId = decodeURIComponent(match[2] ?? '')
  const action = match[3] ?? ''
  const result = action === 'accept'
    ? tournamentEconomyStore.acceptPartnerInviteAtomically(tournamentId, inviteId, authResult.profileId)
    : action === 'decline'
      ? tournamentEconomyStore.declinePartnerInviteAtomically(tournamentId, inviteId, authResult.profileId)
      : tournamentEconomyStore.cancelPartnerInviteAtomically(tournamentId, inviteId, authResult.profileId)
  if (!result.ok) {
    sendJsonResponse(res, getPartnerInviteFailureStatus(result.reason), {
      ok: false,
      reason: result.reason,
      message: PARTNER_INVITE_FAILURE_MESSAGES[result.reason] ?? 'Поканата не бе обработена.',
    })
    return true
  }
  sendJsonResponse(res, 200, {
    ok: true,
    alreadyResolved: result.alreadyResolved === true,
    debitedAmount: result.debitedAmount,
    invite: buildTournamentPartnerInviteDto(result.invite),
    walletBalance: result.walletBalance,
    tournament: buildTournamentSummaryDto(result.tournament, authResult.profileId),
  })
  sendTournamentPartnerInviteResolved(result.invite)
  return true
}

async function handleTournamentJoinRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/tournaments\/([^/]+)\/join$/.exec(pathname)
  if (!match) return false

  if (req.method !== 'POST') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  if (!isAllowedVisitorRequestOrigin(req)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Заявката е отхвърлена.' })
    return true
  }

  const authResult = requireRegisteredHumanSession(req)
  if (!authResult.ok) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си, за да се запишеш.' })
    return true
  }
  const { profileId } = authResult

  if (!requireTournamentBetaAccessOrRespond(res, profileId)) {
    return true
  }

  if (isTournamentEntryActionRateLimited(profileId, Date.now())) {
    sendJsonResponse(res, 429, { ok: false, message: 'Твърде много опити. Опитай отново след малко.' })
    return true
  }

  let tournamentId: string
  try {
    tournamentId = decodeURIComponent(match[1] ?? '')
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден идентификатор на турнир.' })
    return true
  }
  if (!tournamentId) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден идентификатор на турнир.' })
    return true
  }

  // Клиентът не подава profileId/accountId/entryFee/joinedAs/idempotencyKey —
  // всичко идва от session и tournament record. Единственото допустимо поле
  // е password, и то само защото е най-малкият безопасен модел за join към
  // password-protected турнир (виж handleTournamentDetailRequest unlock модела).
  let password: string | null = null
  try {
    const body = await readJsonRequestBody(req)
    if (isRecord(body) && typeof body.password === 'string') {
      password = body.password
    }
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидно JSON тяло.' })
    return true
  }

  const result = tournamentEconomyStore.joinTournamentSoloAtomically(tournamentId, profileId, {
    password,
  })

  if (!result.ok) {
    const status = result.reason === 'tournament_not_found' ? 404
      : result.reason === 'requires_password' ? 403
      : result.reason === 'insufficient_funds' ? 402
      : result.reason === 'tournament_full' || result.reason === 'already_participating_elsewhere'
        || result.reason === 'tournament_not_open' || result.reason === 'rejoin_not_allowed'
        || result.reason === 'tournament_fill_expired' ? 409
      : 400
    sendJsonResponse(res, status, {
      ok: false,
      reason: result.reason,
      message: JOIN_FAILURE_MESSAGES[result.reason] ?? 'Записването не бе успешно.',
      requiresPassword: result.reason === 'requires_password' ? true : undefined,
    })
    return true
  }

  // tournament_events записът за 'entry_confirmed' вече е вписан атомарно
  // вътре в joinTournamentSoloAtomically (същата транзакция като debit-а).

  activityCounters.incrementTournament('tournamentRegistration')

  sendJsonResponse(res, 200, {
    ok: true,
    alreadyJoined: result.alreadyJoined,
    debitedAmount: result.debitedAmount,
    entry: {
      entryId: result.entry.entryId,
      status: result.entry.status,
      joinedAs: result.entry.joinedAs,
      createdAt: result.entry.createdAt,
    },
    walletBalance: result.walletBalance,
    tournament: buildTournamentSummaryDto(result.tournament, profileId),
  })
  return true
}

const LEAVE_FAILURE_MESSAGES: Record<string, string> = {
  entry_not_found: 'Нямаш записване в този турнир.',
  not_own_entry: 'Не можеш да управляваш чуждо записване.',
  tournament_not_open: 'Турнирът вече не е в статус за отказване.',
  entry_not_confirmed: 'Записването не е в статус, позволяващ отказване.',
}

async function handleTournamentLeaveRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/tournaments\/([^/]+)\/leave$/.exec(pathname)
  if (!match) return false

  if (req.method !== 'POST') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  if (!isAllowedVisitorRequestOrigin(req)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Заявката е отхвърлена.' })
    return true
  }

  const authResult = requireRegisteredHumanSession(req)
  if (!authResult.ok) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }
  const { profileId } = authResult

  if (!requireTournamentBetaAccessOrRespond(res, profileId)) {
    return true
  }

  if (isTournamentEntryActionRateLimited(profileId, Date.now())) {
    sendJsonResponse(res, 429, { ok: false, message: 'Твърде много опити. Опитай отново след малко.' })
    return true
  }

  let tournamentId: string
  try {
    tournamentId = decodeURIComponent(match[1] ?? '')
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден идентификатор на турнир.' })
    return true
  }
  if (!tournamentId) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден идентификатор на турнир.' })
    return true
  }

  const result = tournamentEconomyStore.leaveTournamentAndRefundAtomically(tournamentId, profileId)

  if (!result.ok) {
    const status = result.reason === 'entry_not_found' ? 404 : 409
    sendJsonResponse(res, status, {
      ok: false,
      reason: result.reason,
      message: LEAVE_FAILURE_MESSAGES[result.reason] ?? 'Отказването не бе успешно.',
    })
    return true
  }

  // tournament_events записът за 'entry_withdrawn_and_refunded' вече е
  // вписан атомарно вътре в leaveTournamentAndRefundAtomically.

  activityCounters.incrementTournament('tournamentLeave')

  sendJsonResponse(res, 200, {
    ok: true,
    alreadyRefunded: result.alreadyRefunded,
    refundedAmount: result.refundedAmount,
    walletBalance: result.walletBalance,
    tournament: buildTournamentSummaryDto(result.tournament, profileId),
  })

  // Auto-release известие (§ "КОГАТО ЕДИНИЯТ PARTNER СЕ ОТПИШЕ") — само след
  // committed refund (result.ok вече потвърден по-горе), само ако partner-ът
  // реално е бил auto-released в ТОЗИ call (null за нормален solo leave и за
  // alreadyRefunded===true повторен/race call — виж коментара в
  // LeaveTournamentResult). Durable notice row-ът вече е committed вътре в
  // leaveTournamentAndRefundAtomically (виж tournament_partner_left_notice_log) —
  // тук само доставяме: online connections получават push веднага И се
  // маркират delivered (за да не се доставят повторно при следващ login);
  // offline recipients остават delivered_at=NULL до следващия им
  // login/reconnect (виж flush блока при connection setup, огледален на
  // pending_gift_notifications).
  if (result.autoReleasedPartner !== null) {
    const sentCount = sendToOpenProfileConnections(result.autoReleasedPartner.profileId, {
      type: 'tournament_economy_notice',
      eventId: randomUUID(),
      tournamentId,
      reason: 'partner_left' as const,
      amount: result.autoReleasedPartner.refundedAmount,
      occurredAt: new Date().toISOString(),
    })
    if (sentCount > 0) {
      tournamentEconomyStore.markPartnerLeftNoticeDelivered(
        result.autoReleasedPartner.noticeId,
        result.autoReleasedPartner.profileId,
      )
    }
  }
  return true
}

const ACKNOWLEDGE_BOT_RETURN_FAILURE_MESSAGES: Record<string, string> = {
  not_active_participant: 'Не участваш активно в този турнир в момента.',
}

// Server-authoritative "Поеми играта" action ИЗВЪН gameplay (§"AUTHORITATIVE
// RETURN ACTION"/"STATE A"/"STATE B" във второто допълнение) — за разлика от
// resume_room+tryTakeoverNoShowBot (реален seat swap в активна стая), тук
// няма room/seat да се пипа: STATE A/B нямат runnable match за профила в
// момента. Единственото нужно действие е authoritative marking на
// СЪЩЕСТВУВАЩИЯ unresolved replacement ред 'completed' — виж
// acknowledgeTournamentBotReplacementReturn в tournamentCoordinator.ts.
// Idempotent (двоен click/repeat заявка връща alreadyResolved:true, не
// грешка); не пипа wallet/economy/team/match state.
async function handleTournamentAcknowledgeBotReturnRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/tournaments\/([^/]+)\/acknowledge-bot-return$/.exec(pathname)
  if (!match) return false

  if (req.method !== 'POST') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  if (!isAllowedVisitorRequestOrigin(req)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Заявката е отхвърлена.' })
    return true
  }

  const authResult = requireRegisteredHumanSession(req)
  if (!authResult.ok) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }
  const { profileId } = authResult

  if (!requireTournamentBetaAccessOrRespond(res, profileId)) {
    return true
  }

  if (isTournamentEntryActionRateLimited(profileId, Date.now())) {
    sendJsonResponse(res, 429, { ok: false, message: 'Твърде много опити. Опитай отново след малко.' })
    return true
  }

  let tournamentId: string
  try {
    tournamentId = decodeURIComponent(match[1] ?? '')
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден идентификатор на турнир.' })
    return true
  }
  if (!tournamentId) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден идентификатор на турнир.' })
    return true
  }

  if (tournamentCoordinator === null) {
    sendJsonResponse(res, 503, { ok: false, message: 'Услугата временно не е налична.' })
    return true
  }

  const result = tournamentCoordinator.acknowledgeTournamentBotReplacementReturn(tournamentId, profileId)
  if (!result.ok) {
    sendJsonResponse(res, 409, {
      ok: false,
      reason: result.reason,
      message: ACKNOWLEDGE_BOT_RETURN_FAILURE_MESSAGES[result.reason] ?? 'Връщането не бе успешно.',
    })
    return true
  }

  sendJsonResponse(res, 200, { ok: true, alreadyResolved: result.alreadyResolved })
  return true
}

const CANCEL_FAILURE_MESSAGES: Record<string, string> = {
  tournament_not_found: 'Турнирът не е намерен.',
  not_creator: 'Само създателят на турнира може да го отмени.',
  tournament_not_open: 'Турнирът вече не може да бъде отменен.',
}

async function handleTournamentCancelRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/tournaments\/([^/]+)\/cancel$/.exec(pathname)
  if (!match) return false

  if (req.method !== 'POST') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  if (!isAllowedVisitorRequestOrigin(req)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Заявката е отхвърлена.' })
    return true
  }

  const authResult = requireRegisteredHumanSession(req)
  if (!authResult.ok) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }
  const { profileId } = authResult

  if (!requireTournamentBetaAccessOrRespond(res, profileId)) {
    return true
  }

  if (isTournamentEntryActionRateLimited(profileId, Date.now())) {
    sendJsonResponse(res, 429, { ok: false, message: 'Твърде много опити. Опитай отново след малко.' })
    return true
  }

  let tournamentId: string
  try {
    tournamentId = decodeURIComponent(match[1] ?? '')
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден идентификатор на турнир.' })
    return true
  }
  if (!tournamentId) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден идентификатор на турнир.' })
    return true
  }

  const result = tournamentEconomyStore.cancelOpenTournamentAndRefundAtomically(
    tournamentId,
    profileId,
    'Отменен от създателя.',
  )

  if (!result.ok) {
    const status = result.reason === 'tournament_not_found' ? 404
      : result.reason === 'not_creator' ? 403
      : 409
    sendJsonResponse(res, status, {
      ok: false,
      reason: result.reason,
      message: CANCEL_FAILURE_MESSAGES[result.reason] ?? 'Отмяната не бе успешна.',
    })
    return true
  }

  // tournament_events записът за 'tournament_cancelled_by_creator' вече е
  // вписан атомарно вътре в cancelOpenTournamentAndRefundAtomically.

  sendJsonResponse(res, 200, {
    ok: true,
    alreadyCancelled: result.alreadyCancelled,
    refundedEntries: result.refundedEntries,
    totalRefunded: result.totalRefunded,
    walletBalance: result.walletBalance,
    tournament: buildTournamentSummaryDto(result.tournament, profileId),
  })
  if (!result.alreadyCancelled && result.refundedProfiles.length > 0) {
    sendTournamentEconomyRefundNotices(tournamentId, 'creator_cancelled', result.refundedProfiles)
  }
  return true
}

const adminTournamentActionRateLimitByProfileId = new Map<string, { count: number; windowStartedAt: number }>()
const ADMIN_TOURNAMENT_ACTION_RATE_LIMIT_WINDOW_MS = 60_000
const ADMIN_TOURNAMENT_ACTION_RATE_LIMIT_MAX_PER_WINDOW = 12

function isAdminTournamentActionRateLimited(profileId: string, nowMs: number): boolean {
  const existing = adminTournamentActionRateLimitByProfileId.get(profileId)
  if (
    existing === undefined ||
    nowMs - existing.windowStartedAt >= ADMIN_TOURNAMENT_ACTION_RATE_LIMIT_WINDOW_MS
  ) {
    adminTournamentActionRateLimitByProfileId.set(profileId, { count: 1, windowStartedAt: nowMs })
    return false
  }
  if (existing.count >= ADMIN_TOURNAMENT_ACTION_RATE_LIMIT_MAX_PER_WINDOW) return true
  existing.count += 1
  return false
}

function getAdminTournamentPageParam(requestUrl: URL, name: string, fallback: number): number | null {
  const raw = requestUrl.searchParams.get(name)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 1 || Math.floor(value) !== value) return null
  return value
}

function getAdminTournamentEnumParam<T extends readonly string[]>(
  requestUrl: URL,
  name: string,
  values: T,
): T[number] | null | undefined {
  const raw = requestUrl.searchParams.get(name)
  if (raw === null || raw === '') return null
  return values.includes(raw) ? raw : undefined
}

function getAdminTournamentDateParam(requestUrl: URL, name: string): string | null | undefined {
  const raw = requestUrl.searchParams.get(name)
  if (raw === null || raw.trim() === '') return null
  const value = raw.trim()
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return undefined
  return new Date(ms).toISOString()
}

function decodeAdminTournamentId(raw: string | undefined): string | null {
  try {
    const value = decodeURIComponent(raw ?? '').trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

async function handleAdminTournamentsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  requestUrl: URL,
): Promise<boolean> {
  const detailMatch = /^\/api\/admin\/tournaments\/([^/]+)$/.exec(pathname)
  const actionMatch = /^\/api\/admin\/tournaments\/([^/]+)\/(reconcile|cancel-open)$/.exec(pathname)
  if (pathname !== '/api/admin/tournaments' && detailMatch === null && actionMatch === null) return false

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)
  const isWrite = actionMatch !== null

  if (isWrite) {
    if (!isFullAdminSession(session)) {
      sendJsonResponse(res, 403, { ok: false, message: 'No permission.' })
      return true
    }
    if (!isAllowedVisitorRequestOrigin(req)) {
      sendJsonResponse(res, 403, { ok: false, message: 'Request rejected.' })
      return true
    }
    const actorProfileId = session.profile.profileId
    if (actorProfileId === null) {
      sendJsonResponse(res, 403, { ok: false, message: 'No permission.' })
      return true
    }
    if (isAdminTournamentActionRateLimited(actorProfileId, Date.now())) {
      sendJsonResponse(res, 429, { ok: false, message: 'Too many attempts. Try again later.' })
      return true
    }
  } else if (!isAdminOrSubadminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'No permission.' })
    return true
  }

  if (pathname === '/api/admin/tournaments') {
    if (req.method !== 'GET') {
      sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
      return true
    }

    const page = getAdminTournamentPageParam(requestUrl, 'page', 1)
    const limit = getAdminTournamentPageParam(requestUrl, 'limit', 25)
    if (page === null || limit === null || limit > 100) {
      sendJsonResponse(res, 400, { ok: false, message: 'Invalid pagination.' })
      return true
    }

    const status = getAdminTournamentEnumParam(requestUrl, 'status', TOURNAMENT_STATUSES)
    const settlementState = getAdminTournamentEnumParam(requestUrl, 'settlementState', ['pending', 'settled'] as const)
    const visibility = getAdminTournamentEnumParam(requestUrl, 'visibility', ['public', 'password'] as const)
    const startMode = getAdminTournamentEnumParam(requestUrl, 'startMode', ['fill', 'scheduled'] as const)
    const integrityState = getAdminTournamentEnumParam(requestUrl, 'integrityState', ['healthy', 'warning', 'error'] as const)
    const createdFrom = getAdminTournamentDateParam(requestUrl, 'createdFrom')
    const createdTo = getAdminTournamentDateParam(requestUrl, 'createdTo')
    const finishedFrom = getAdminTournamentDateParam(requestUrl, 'finishedFrom')
    const finishedTo = getAdminTournamentDateParam(requestUrl, 'finishedTo')
    const rawSearch = requestUrl.searchParams.get('search')?.trim() ?? ''

    if (
      status === undefined || settlementState === undefined || visibility === undefined ||
      startMode === undefined || integrityState === undefined || createdFrom === undefined ||
      createdTo === undefined || finishedFrom === undefined || finishedTo === undefined
    ) {
      sendJsonResponse(res, 400, { ok: false, message: 'Invalid filter.' })
      return true
    }
    if (rawSearch.length > 80) {
      sendJsonResponse(res, 400, { ok: false, message: 'Search is too long.' })
      return true
    }

    const result = tournamentAdminStore.listAdminTournaments({
      page,
      limit,
      status,
      settlementState,
      visibility,
      startMode,
      integrityState: integrityState as TournamentIntegrityState | null,
      createdFrom,
      createdTo,
      finishedFrom,
      finishedTo,
      search: rawSearch === '' ? null : rawSearch,
    })

    sendJsonResponse(res, 200, {
      ok: true,
      tournaments: result.rows,
      page,
      limit,
      totalCount: result.totalCount,
      viewerRole: session.account.role,
      canWrite: session.account.role === 'admin',
    })
    return true
  }

  if (detailMatch !== null) {
    if (req.method !== 'GET') {
      sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
      return true
    }

    const tournamentId = decodeAdminTournamentId(detailMatch[1])
    const eventPage = getAdminTournamentPageParam(requestUrl, 'eventPage', 1)
    const eventLimit = getAdminTournamentPageParam(requestUrl, 'eventLimit', 25)
    if (tournamentId === null || eventPage === null || eventLimit === null || eventLimit > 100) {
      sendJsonResponse(res, 400, { ok: false, message: 'Invalid tournament request.' })
      return true
    }

    const tournament = tournamentAdminStore.getAdminTournamentDetail(tournamentId, eventPage, eventLimit)
    if (tournament === null) {
      sendJsonResponse(res, 404, { ok: false, message: 'Tournament not found.' })
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      tournament,
      viewerRole: session.account.role,
      canWrite: session.account.role === 'admin',
    })
    return true
  }

  if (actionMatch !== null) {
    if (req.method !== 'POST') {
      sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
      return true
    }

    const tournamentId = decodeAdminTournamentId(actionMatch[1])
    if (tournamentId === null) {
      sendJsonResponse(res, 400, { ok: false, message: 'Invalid tournament id.' })
      return true
    }

    if (actionMatch[2] === 'reconcile') {
      const result = tournamentAdminStore.reconcileTournament(tournamentId, session.profile.profileId)
      if (!result.ok) {
        sendJsonResponse(res, result.status === 'not_found' ? 404 : 409, {
          ok: false,
          status: result.status,
          message: result.status === 'blocked_by_integrity_error'
            ? 'Synchronization is blocked by a data integrity problem.'
            : 'Tournament not found.',
        })
        return true
      }
      sendJsonResponse(res, 200, { ok: true, status: result.status })
      return true
    }

    const result = tournamentAdminStore.cancelOpenTournament(tournamentId, session.profile.profileId)
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404
        : result.reason === 'not_open' || result.reason === 'unsafe_state' || result.reason === 'integrity_error'
          ? 409
          : 400
      sendJsonResponse(res, status, {
        ok: false,
        reason: result.reason,
        message: result.reason === 'not_open'
          ? 'The tournament has already started and cannot be cancelled.'
          : 'The tournament cannot be cancelled safely.',
      })
      return true
    }
    sendJsonResponse(res, 200, {
      ok: true,
      alreadyCancelled: result.alreadyCancelled,
      refundedEntries: result.refundedEntries,
      totalRefunded: result.totalRefunded,
    })
    return true
  }

  return false
}

async function handleShopResumeCheckoutRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = pathname.match(/^\/api\/shop\/purchases\/([^/]+)\/resume-checkout$/)

  if (!match || req.method !== 'POST') {
    return false
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY

  if (!stripeSecretKey) {
    sendJsonResponse(res, 500, {
      ok: false,
      message: 'Stripe не е конфигуриран на сървъра. Моля, свържи се с администратор.',
    })
    return true
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null || session.profile.profileId === null) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си.',
    })
    return true
  }

  const purchaseId = match[1]
  const profileId = session.profile.profileId

  const stripe = new Stripe(stripeSecretKey)

  const clientOrigin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173'
  const successUrl =
    process.env.STRIPE_SUCCESS_URL ??
    `${clientOrigin}/lobby?payment=success&session_id={CHECKOUT_SESSION_ID}`
  const cancelUrl =
    process.env.STRIPE_CANCEL_URL ?? `${clientOrigin}/lobby?payment=cancel`

  const result = await resumeCoinPurchaseCheckout({
    store: coinPurchaseStore,
    stripe,
    purchaseId,
    profileId,
    successUrl,
    cancelUrl,
  })

  if (!result.ok) {
    sendJsonResponse(res, result.status, { ok: false, message: result.message })
    return true
  }

  sendJsonResponse(res, 200, { ok: true, checkoutUrl: result.checkoutUrl, purchase: result.purchase })
  return true
}

async function handleShopHidePurchaseRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = pathname.match(/^\/api\/shop\/purchases\/([^/]+)\/hide$/)

  if (!match || req.method !== 'PATCH') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null || session.profile.profileId === null) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си.',
    })
    return true
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY

  if (!stripeSecretKey) {
    sendJsonResponse(res, 500, {
      ok: false,
      message: 'Stripe не е конфигуриран на сървъра. Моля, свържи се с администратор.',
    })
    return true
  }

  const stripe = new Stripe(stripeSecretKey)
  const purchaseId = match[1]
  const profileId = session.profile.profileId

  const result = await hideCoinPurchase({
    store: coinPurchaseStore,
    stripe,
    purchaseId,
    profileId,
  })

  if (!result.ok) {
    sendJsonResponse(res, result.status, { ok: false, message: result.message })
    return true
  }

  sendJsonResponse(res, 200, {
    ok: true,
    purchases: coinPurchaseStore.listProfilePurchases(profileId),
  })

  return true
}

async function handleStripeWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/stripe/webhook' || req.method !== 'POST') {
    return false
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  if (!stripeSecretKey || !webhookSecret) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Stripe webhook не е конфигуриран на сървъра.')
    return true
  }

  const rawBody = await readRawRequestBody(req)
  const signatureHeader = req.headers['stripe-signature']

  if (!signatureHeader || typeof signatureHeader !== 'string') {
    sendJsonResponse(res, 400, {
      ok: false,
      message: 'Липсва Stripe-Signature header.',
    })
    return true
  }

  const stripe = new Stripe(stripeSecretKey)

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret)
  } catch (error) {
    sendJsonResponse(res, 400, {
      ok: false,
      message:
        error instanceof Error ? error.message : 'Невалиден Stripe подпис.',
    })
    return true
  }

  if (event.type === 'checkout.session.completed') {
    const stripeSession = event.data.object as Stripe.Checkout.Session

    if (stripeSession.metadata?.purchaseType === 'vip') {
      const purchaseId = stripeSession.metadata?.purchaseId ?? ''
      const checkoutSessionId = stripeSession.id

      const vipResult = vipPurchaseStore.fulfillPaidPurchase({
        checkoutSessionId,
        purchaseId,
        stripePaymentStatus: stripeSession.payment_status,
        stripeCurrency: (stripeSession.currency ?? '').toUpperCase(),
        stripeAmountTotalCents: stripeSession.amount_total ?? -1,
      })

      if (!vipResult.ok) {
        console.error(
          `[stripe/webhook] VIP fulfillPaidPurchase failed session=${checkoutSessionId} purchaseId=${purchaseId} message=${vipResult.message}`,
        )
      } else if (vipResult.alreadyCredited) {
        console.log(
          `[stripe/webhook] VIP already credited session=${checkoutSessionId} purchaseId=${purchaseId}`,
        )
      } else {
        console.log(
          `[stripe/webhook] VIP fulfilled purchaseId=${vipResult.purchase.purchaseId} package=${vipResult.purchase.packageId} newActiveUntil=${vipResult.newActiveUntil}`,
        )
      }

      // Payment-method enrichment — mirror на coin flow-a (Step 2 по-долу).
      // Settlement (grant/credit) вече е приключил (успешно ИЛИ е бил
      // already-credited) преди тази точка — enrichment е чисто display-only
      // обогатяване на Admin -> Плащания и НИКОГА не трябва да влияе на/да
      // отменя вече settle-натото плащане. Ако vipResult.ok е false
      // (settlement реално неуспешен, редът остава pending), enrichment
      // изобщо не се опитва тук — следващ webhook retry ще опита пълния
      // settlement отново, enrichment ще последва тогава.
      if (vipResult.ok) {
        const vipFulfilledPurchaseId = vipResult.purchase.purchaseId
        const vipPaymentIntentId =
          typeof stripeSession.payment_intent === 'string'
            ? stripeSession.payment_intent
            : (stripeSession.payment_intent as { id?: string } | null)?.id ?? null

        if (vipPaymentIntentId && vipPurchaseStore.needsPaymentMethodSnapshot(vipFulfilledPurchaseId)) {
          try {
            const vipPi = await stripe.paymentIntents.retrieve(vipPaymentIntentId, {
              expand: ['latest_charge'],
            })

            let vipCharge: Stripe.Charge | null = null
            if (vipPi.latest_charge && typeof vipPi.latest_charge === 'object') {
              vipCharge = vipPi.latest_charge as Stripe.Charge
            } else if (vipPi.latest_charge && typeof vipPi.latest_charge === 'string') {
              vipCharge = await stripe.charges.retrieve(vipPi.latest_charge)
            }

            const vipPmd = vipCharge?.payment_method_details ?? null
            const vipCardDetails = vipPmd?.card ?? null
            const vipWalletDetails = vipCardDetails?.wallet ?? null

            vipPurchaseStore.updatePaymentMethodSnapshot(vipFulfilledPurchaseId, {
              stripePaymentIntentId: vipPaymentIntentId,
              stripeChargeId: vipCharge?.id ?? null,
              paymentMethodType: vipPmd?.type ?? null,
              walletType: vipWalletDetails?.type ?? null,
              cardBrand: vipCardDetails?.brand ?? null,
              cardLast4: vipCardDetails?.last4 ?? null,
              cardCountry: vipCardDetails?.country ?? null,
            })
            console.log(
              `[stripe/webhook] VIP enriched purchaseId=${vipFulfilledPurchaseId} method=${vipPmd?.type ?? 'null'} wallet=${vipWalletDetails?.type ?? 'null'}`,
            )
          } catch (vipEnrichErr) {
            // Log and continue — enrichment failure must never risk/undo VIP credit.
            console.warn(
              `[stripe/webhook] VIP payment method enrichment failed purchaseId=${vipFulfilledPurchaseId}:`,
              vipEnrichErr instanceof Error ? vipEnrichErr.message : String(vipEnrichErr),
            )
          }
        }
      }

      sendJsonResponse(res, 200, { ok: true })
      return true
    }

    if (stripeSession.payment_status === 'paid') {
      const purchaseId = stripeSession.metadata?.purchaseId ?? ''
      const checkoutSessionId = stripeSession.id
      const amountPaidCents = stripeSession.amount_total ?? 0
      const currency = stripeSession.currency ?? ''

      // Step 1: fulfill atomically — this MUST succeed regardless of Stripe enrichment
      const result = coinPurchaseStore.fulfillPaidPurchase({
        checkoutSessionId,
        purchaseId,
        amountPaidCents,
        currency,
      })

      if (!result.ok) {
        console.error(
          `[stripe/webhook] fulfillPaidPurchase failed session=${checkoutSessionId} purchaseId=${purchaseId} message=${result.message}`,
        )
      } else {
        if (result.alreadyCredited) {
          console.log(
            `[stripe/webhook] already credited session=${checkoutSessionId} purchaseId=${purchaseId}`,
          )
        } else {
          console.log(
            `[stripe/webhook] fulfilled purchaseId=${result.purchase.purchaseId} coins=${result.purchase.yellowCoinsAmount}`,
          )
        }

        // Step 2: enrich payment method snapshot — non-blocking, must not affect credits.
        // Runs on first webhook AND on repeated webhooks when snapshot is still missing
        // (alreadyCredited=true but snapshot was never written, e.g. enrichment failed earlier).
        const fulfilledPurchaseId = result.purchase.purchaseId
        const paymentIntentId =
          typeof stripeSession.payment_intent === 'string'
            ? stripeSession.payment_intent
            : (stripeSession.payment_intent as { id?: string } | null)?.id ?? null

        if (paymentIntentId && coinPurchaseStore.needsPaymentMethodSnapshot(fulfilledPurchaseId)) {
          try {
            const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
              expand: ['latest_charge'],
            })

            // latest_charge may be an expanded Charge object or a bare string ID
            let charge: Stripe.Charge | null = null
            if (pi.latest_charge && typeof pi.latest_charge === 'object') {
              charge = pi.latest_charge as Stripe.Charge
            } else if (pi.latest_charge && typeof pi.latest_charge === 'string') {
              charge = await stripe.charges.retrieve(pi.latest_charge)
            }
            // charge remains null if latest_charge is null

            const pmd = charge?.payment_method_details ?? null
            const cardDetails = pmd?.card ?? null
            const walletDetails = cardDetails?.wallet ?? null

            coinPurchaseStore.updatePaymentMethodSnapshot(fulfilledPurchaseId, {
              stripePaymentIntentId: paymentIntentId,
              stripeChargeId: charge?.id ?? null,
              paymentMethodType: pmd?.type ?? null,
              walletType: walletDetails?.type ?? null,
              cardBrand: cardDetails?.brand ?? null,
              cardLast4: cardDetails?.last4 ?? null,
              cardCountry: cardDetails?.country ?? null,
            })
            console.log(
              `[stripe/webhook] enriched purchaseId=${fulfilledPurchaseId} method=${pmd?.type ?? 'null'} wallet=${walletDetails?.type ?? 'null'}`,
            )
          } catch (enrichErr) {
            // Log and continue — enrichment failure must never risk double-credit
            console.warn(
              `[stripe/webhook] payment method enrichment failed purchaseId=${fulfilledPurchaseId}:`,
              enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
            )
          }
        } else if (paymentIntentId) {
          console.log(
            `[stripe/webhook] snapshot already complete purchaseId=${fulfilledPurchaseId}, skipping enrichment`,
          )
        }
      }
    }
  } else if (event.type === 'checkout.session.expired') {
    const stripeSession = event.data.object as Stripe.Checkout.Session
    if (stripeSession.metadata?.purchaseType === 'vip') {
      vipPurchaseStore.markPurchaseCanceledByCheckoutSessionId(stripeSession.id)
    } else {
      coinPurchaseStore.markPurchaseCanceledByCheckoutSessionId(stripeSession.id)
    }
  }

  sendJsonResponse(res, 200, { ok: true })
  return true
}

async function handleAdminSettingsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/admin/settings') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isFullAdminSession(session)) {
    sendJsonResponse(res, 403, {
      ok: false,
      message: 'Нямаш достъп до админ настройките.',
    })
    return true
  }

  if (req.method === 'GET') {
    sendJsonResponse(res, 200, {
      ok: true,
      settings: adminSettingsStore.getSettings(),
    })
    return true
  }

  if (req.method === 'PATCH') {
    const body = await readJsonRequestBody(req)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Invalid request body.',
      })
      return true
    }

    // getNumberField() връща null еднакво за "полето липсва" И "полето е
    // подадено, но не е валидно число" (string/bool/array/null) — updateSettings
    // третира ?? undefined като "не е подадено", значи невалиден тип тихо се
    // пропуска (HTTP 200, стойността в базата остава непроменена). За explicit
    // reject (VIP price audit брифа §6 — "NaN/string garbage -> 400", не silent
    // ignore) правим локална проверка тук САМО за КЛЮЧОВЕ, реално присъстващи в
    // body-то, без да пипаме споделения getNumberField helper (26 други call
    // sites другаде в този файл).
    const numericFieldKeys = [
      'signupBonusYellowCoins',
      'profileNameChangePrice',
      'vipPrice30DaysCents',
      'vipPrice180DaysCents',
      'vipPrice365DaysCents',
      'pikaTeamDailyGiftLimit',
    ] as const
    for (const key of numericFieldKeys) {
      if (key in body && getNumberField(body, key) === null) {
        sendJsonResponse(res, 400, {
          ok: false,
          message: `Полето "${key}" трябва да е валидно число.`,
        })
        return true
      }
    }

    const result = adminSettingsStore.updateSettings({
      signupBonusYellowCoins: getNumberField(body, 'signupBonusYellowCoins') ?? undefined,
      profileNameChangePrice: getNumberField(body, 'profileNameChangePrice') ?? undefined,
      vipPrice30DaysCents: getNumberField(body, 'vipPrice30DaysCents') ?? undefined,
      vipPrice180DaysCents: getNumberField(body, 'vipPrice180DaysCents') ?? undefined,
      vipPrice365DaysCents: getNumberField(body, 'vipPrice365DaysCents') ?? undefined,
      pikaTeamDailyGiftLimit: getNumberField(body, 'pikaTeamDailyGiftLimit') ?? undefined,
    })

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      settings: result.settings,
    })
    return true
  }

  return false
}

async function handleAdminCoinPackagesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const statusMatch = /^\/api\/admin\/coin-packages\/([^/]+)\/status$/.exec(pathname)
  const lobbyMatch = /^\/api\/admin\/coin-packages\/([^/]+)\/lobby$/.exec(pathname)
  const topOfferMatch = /^\/api\/admin\/coin-packages\/([^/]+)\/top-offer$/.exec(pathname)
  const deleteMatch = /^\/api\/admin\/coin-packages\/([^/]+)$/.exec(pathname)

  if (
    pathname !== '/api/admin/coin-packages' &&
    statusMatch === null &&
    lobbyMatch === null &&
    topOfferMatch === null &&
    deleteMatch === null
  ) {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isFullAdminSession(session)) {
    sendJsonResponse(res, 403, {
      ok: false,
      message: 'Нямаш достъп до админ пакетите.',
    })
    return true
  }

  if (pathname === '/api/admin/coin-packages' && req.method === 'GET') {
    sendJsonResponse(res, 200, {
      ok: true,
      packages: coinPackageStore.listAdminPackages(),
    })
    return true
  }

  if (pathname === '/api/admin/coin-packages' && req.method === 'POST') {
    const body = await readJsonRequestBody(req)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Invalid request body.',
      })
      return true
    }

    const result = coinPackageStore.upsertPackage({
      packageId: getStringField(body, 'packageId') || null,
      packageKey: getStringField(body, 'packageKey'),
      title: getStringField(body, 'title'),
      description: getStringField(body, 'description'),
      yellowCoinsAmount: getNumberField(body, 'yellowCoinsAmount') ?? 0,
      priceCents: getNumberField(body, 'priceCents') ?? -1,
      currency: getStringField(body, 'currency') || 'EUR',
      status: getStringField(body, 'status') as CoinPackageStatus,
      sortOrder: getNumberField(body, 'sortOrder') ?? 0,
      showInLobby: body['showInLobby'] === true,
      isTopOffer: body['isTopOffer'] === true,
    })

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      package: result.package,
      packages: coinPackageStore.listAdminPackages(),
    })
    return true
  }

  if (deleteMatch !== null && req.method === 'DELETE') {
    const result = coinPackageStore.deletePackage(decodeURIComponent(deleteMatch[1] ?? ''))

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(res, 200, { ok: true, packages: result.packages })
    return true
  }

  if (statusMatch !== null && req.method === 'PATCH') {
    const body = await readJsonRequestBody(req)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Invalid request body.',
      })
      return true
    }

    const result = coinPackageStore.setPackageStatus(
      decodeURIComponent(statusMatch[1] ?? ''),
      getStringField(body, 'status') as CoinPackageStatus,
    )

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      package: result.package,
      packages: coinPackageStore.listAdminPackages(),
    })
    return true
  }

  if (lobbyMatch !== null && req.method === 'PATCH') {
    const body = await readJsonRequestBody(req)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Invalid request body.' })
      return true
    }

    const showInLobby = body['showInLobby'] === true

    const result = coinPackageStore.setPackageLobbyVisibility(
      decodeURIComponent(lobbyMatch[1] ?? ''),
      showInLobby,
    )

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      package: result.package,
      packages: coinPackageStore.listAdminPackages(),
    })
    return true
  }

  if (topOfferMatch !== null && req.method === 'PATCH') {
    const body = await readJsonRequestBody(req)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Invalid request body.' })
      return true
    }

    const isTopOffer = body['isTopOffer'] === true

    const result = coinPackageStore.setPackageTopOffer(
      decodeURIComponent(topOfferMatch[1] ?? ''),
      isTopOffer,
    )

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      package: result.package,
      packages: coinPackageStore.listAdminPackages(),
    })
    return true
  }

  return false
}

// Общ tail за gift routes (нормален friend-to-friend gift-coins и pika_team
// direct bypass по-долу) — идентична WS notify / gift-notification-log /
// JSON response логика и за двата route-а, единствената разлика между тях е
// как се resolve-ва получателят (виж yellowCoinGiftStore.ts sendGift vs.
// sendGiftToProfile). Извлечено тук, за да не се дублира ~30 реда код 1:1.
function notifyGiftRecipientAndRespond(
  res: ServerResponse,
  result: {
    ok: true
    gift: YellowCoinGiftSnapshot
    senderProfile: PlayerPublicProfileSnapshot
    recipientProfile: PlayerPublicProfileSnapshot
  },
  isRoleBasedPikaTeamSender: boolean = false,
): void {
  const recipientProfileId = result.recipientProfile.profileId
  if (recipientProfileId) {
    const recipientConn = Object.values(serverState.connections).find(
      (c) => c.profileId === recipientProfileId && c.status === 'connected' && c.currentRoomId == null,
    )
    const senderName = result.senderProfile.displayName ?? 'Играч'
    if (recipientConn) {
      safeSendToConnection(recipientConn.id, {
        type: 'coins_gifted',
        amount: result.gift.amount,
        fromDisplayName: senderName,
        recipientNewBalance: result.recipientProfile.yellowCoinsBalance ?? 0,
      })
    } else {
      yellowCoinGiftStore.createGiftNotification(
        result.gift.giftId,
        recipientProfileId,
        senderName,
        result.gift.amount,
      )
    }
  }

  // Informational UI update без пълен page/session rerender (CLAUDE.md
  // изискването "Profile gift UI" — след успешен gift обнови used/remaining
  // без да затвориш profile popup-а). Само за pika_team sender-и — за
  // всички останали полето е undefined, клиентът не показва лимит блока.
  const pikaTeamDailyGiftLimitStatus = isRoleBasedPikaTeamSender && result.senderProfile.profileId !== null
    ? yellowCoinGiftStore.getPikaTeamDailyGiftLimitStatus(result.senderProfile.profileId)
    : undefined

  sendJsonResponse(res, 200, {
    ok: true,
    gift: result.gift,
    senderProfile: result.senderProfile,
    recipientProfile: result.recipientProfile,
    pikaTeamDailyGiftLimitStatus,
  })
}

async function handleFriendsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const friendActionMatch =
    /^\/api\/friends\/([^/]+)\/(accept|reject|cancel|remove)$/.exec(pathname)
  const friendGiftMatch = /^\/api\/friends\/([^/]+)\/gift-coins$/.exec(pathname)
  const giftNotifReadMatch = /^\/api\/gifts\/([^/]+)\/read-notification$/.exec(pathname)
  const friendReadAcceptanceMatch = /^\/api\/friends\/([^/]+)\/read-acceptance$/.exec(pathname)

  if (
    pathname !== '/api/friends' &&
    pathname !== '/api/friends/request' &&
    pathname !== '/api/friends/gift-coins/direct' &&
    friendGiftMatch === null &&
    friendActionMatch === null &&
    giftNotifReadMatch === null &&
    friendReadAcceptanceMatch === null
  ) {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null || session.profile.profileId === null) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си.',
    })
    return true
  }

  const profileId = session.profile.profileId

  if (pathname === '/api/friends' && req.method === 'GET') {
    const rawFriendships = friendshipStore.listForProfile(profileId)
    const enrichOnlineStatus = <T extends { profile: { profileId: string | null } }>(rel: T) => {
      const conn = rel.profile.profileId
        ? Object.values(serverState.connections).find(
            (c) => c.profileId === rel.profile.profileId && c.status === 'connected',
          )
        : null
      return {
        ...rel,
        isOnline: conn != null,
        isInGame: conn?.currentRoomId != null,
      }
    }
    sendJsonResponse(res, 200, {
      ok: true,
      friendships: {
        incomingPending: rawFriendships.incomingPending.map(enrichOnlineStatus),
        outgoingPending: rawFriendships.outgoingPending.map(enrichOnlineStatus),
        friends: rawFriendships.friends.map(enrichOnlineStatus),
      },
    })
    return true
  }

  if (pathname === '/api/friends/request' && req.method === 'POST') {
    const body = await readJsonRequestBody(req)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Invalid request body.',
      })
      return true
    }

    const addresseeProfileId = getStringField(body, 'profileId').trim()

    if (playerProgressStore.isTemporaryProfile(addresseeProfileId)) {
      sendJsonResponse(res, 200, { ok: false, message: 'Поканата беше отхвърлена.' })
      return true
    }

    const result = friendshipStore.sendRequest(profileId, addresseeProfileId)

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    const requesterProfile = playerProgressStore.getPublicProfile(profileId)
    if (requesterProfile) {
      sendToOpenProfileConnections(addresseeProfileId, {
        type: 'friend_request_received',
        friendshipId: result.friendshipId,
        fromProfileId: profileId,
        fromDisplayName: requesterProfile.displayName,
        fromAvatarUrl: requesterProfile.avatarUrl,
      })
    }

    sendJsonResponse(res, 200, {
      ok: true,
      friendships: result.friendships,
    })
    return true
  }

  if (friendGiftMatch !== null && req.method === 'POST') {
    const friendshipId = decodeURIComponent(friendGiftMatch[1]).trim()
    const body = await readJsonRequestBody(req)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Invalid request body.',
      })
      return true
    }

    const amount = getNumberField(body, 'amount')

    if (amount === null) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Невалидна сума за подарък.',
      })
      return true
    }

    const result = yellowCoinGiftStore.sendGift(profileId, friendshipId, amount, isPikaTeamGiftMaxAmountSession(session))

    if (!result.ok) {
      if ('code' in result && result.code === 'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED') {
        sendJsonResponse(res, 400, {
          ok: false,
          code: result.code,
          message: result.message,
          limit: result.limit,
          used: result.used,
          remaining: result.remaining,
          attemptedAmount: result.attemptedAmount,
        })
      } else if ('code' in result) {
        sendJsonResponse(res, 400, {
          ok: false,
          code: result.code,
          message: result.message,
          receivedInWindow: result.receivedInWindow,
          remainingAllowance: result.remainingAllowance,
          attemptedAmount: result.attemptedAmount,
          nextReleaseAt: result.nextReleaseAt,
          nextReleaseAmount: result.nextReleaseAmount,
        })
      } else {
        sendJsonResponse(res, 400, { ok: false, message: result.message })
      }
      return true
    }

    notifyGiftRecipientAndRespond(res, result, isPikaTeamGiftMaxAmountSession(session))
    return true
  }

  // pika_team friendship-gate bypass — production hotfix брифа: "Екип
  // Pika.bg" трябва да може да подари жълтици на всеки регистриран играч,
  // без accepted friendship. Reuse-ва СЪЩИЯ yellowCoinGiftStore ledger/
  // лимити/validation (sendGiftToProfile дели цялото ядро с sendGift по-
  // горе, виж yellowCoinGiftStore.ts) — единствената разлика е адресиране
  // по recipientProfileId вместо friendshipId. Authoritative gate тук е
  // isPikaTeamGiftFriendshipBypassSession (role==='pika_team' единствено) —
  // никоя друга роля не може да достигне до този route.
  if (pathname === '/api/friends/gift-coins/direct' && req.method === 'POST') {
    if (!isPikaTeamGiftFriendshipBypassSession(session)) {
      sendJsonResponse(res, 403, {
        ok: false,
        message: 'Нямаш право да подаряваш жълтици без приятелство.',
      })
      return true
    }

    const body = await readJsonRequestBody(req)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Invalid request body.',
      })
      return true
    }

    const recipientProfileId = getStringField(body, 'recipientProfileId').trim()
    const amount = getNumberField(body, 'amount')

    if (recipientProfileId.length === 0) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Невалиден получател.',
      })
      return true
    }

    if (amount === null) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Невалидна сума за подарък.',
      })
      return true
    }

    const result = yellowCoinGiftStore.sendGiftToProfile(profileId, recipientProfileId, amount, isPikaTeamGiftMaxAmountSession(session))

    if (!result.ok) {
      if ('code' in result && result.code === 'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED') {
        sendJsonResponse(res, 400, {
          ok: false,
          code: result.code,
          message: result.message,
          limit: result.limit,
          used: result.used,
          remaining: result.remaining,
          attemptedAmount: result.attemptedAmount,
        })
      } else if ('code' in result) {
        sendJsonResponse(res, 400, {
          ok: false,
          code: result.code,
          message: result.message,
          receivedInWindow: result.receivedInWindow,
          remainingAllowance: result.remainingAllowance,
          attemptedAmount: result.attemptedAmount,
          nextReleaseAt: result.nextReleaseAt,
          nextReleaseAmount: result.nextReleaseAmount,
        })
      } else {
        sendJsonResponse(res, 400, { ok: false, message: result.message })
      }
      return true
    }

    notifyGiftRecipientAndRespond(res, result, isPikaTeamGiftMaxAmountSession(session))
    return true
  }

  if (giftNotifReadMatch !== null && req.method === 'POST') {
    const giftId = decodeURIComponent(giftNotifReadMatch[1]).trim()
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(giftId)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалиден gift ID.' })
      return true
    }
    yellowCoinGiftStore.markGiftNotificationRead(giftId, profileId)
    sendJsonResponse(res, 200, { ok: true })
    return true
  }

  if (friendActionMatch !== null && req.method === 'POST') {
    const friendshipId = decodeURIComponent(friendActionMatch[1]).trim()
    const action = friendActionMatch[2]

    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(friendshipId)) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Невалидна покана.',
      })
      return true
    }

    const result =
      action === 'accept'
        ? friendshipStore.acceptRequest(profileId, friendshipId)
        : action === 'reject'
          ? friendshipStore.rejectRequest(profileId, friendshipId)
          : action === 'cancel'
            ? friendshipStore.cancelRequest(profileId, friendshipId)
            : friendshipStore.removeRelationship(profileId, friendshipId)

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    if (action === 'accept') {
      const rawReqId = 'requesterProfileId' in result ? result.requesterProfileId : null
      const requesterProfileId: string | null =
        typeof rawReqId === 'string' && rawReqId.length > 0 ? rawReqId : null
      if (requesterProfileId) {
        const accepterProfile = playerProgressStore.getPublicProfile(profileId)
        if (accepterProfile) {
          sendToOpenProfileConnections(requesterProfileId, {
            type: 'friend_request_accepted',
            friendshipId,
            fromProfileId: profileId,
            fromDisplayName: accepterProfile.displayName,
            fromAvatarUrl: accepterProfile.avatarUrl,
          })
        }
      }
    }

    if (
      action === 'cancel' &&
      'addresseeProfileId' in result &&
      typeof result.addresseeProfileId === 'string' &&
      result.addresseeProfileId.length > 0
    ) {
      sendToOpenProfileConnections(result.addresseeProfileId, {
        type: 'friend_request_cancelled',
        friendshipId,
        fromProfileId: profileId,
      })
    }

    if (action === 'reject') {
      const rawReqId = 'requesterProfileId' in result ? result.requesterProfileId : null
      const requesterProfileId: string | null =
        typeof rawReqId === 'string' && rawReqId.length > 0 ? rawReqId : null
      if (requesterProfileId) {
        sendToOpenProfileConnections(requesterProfileId, {
          type: 'friend_request_rejected',
          friendshipId,
        })
      }
    }

    sendJsonResponse(res, 200, {
      ok: true,
      friendships: result.friendships,
    })
    return true
  }

  if (friendReadAcceptanceMatch !== null && req.method === 'POST') {
    const friendshipId = decodeURIComponent(friendReadAcceptanceMatch[1]).trim()
    const readResult = friendshipStore.markAcceptanceRead(profileId, friendshipId)

    if (!readResult.ok) {
      if (readResult.reason === 'invalid_id') {
        sendJsonResponse(res, 400, { ok: false, message: 'Невалиден friendship ID.' })
        return true
      }
      if (readResult.reason === 'not_found') {
        sendJsonResponse(res, 404, { ok: false, message: 'Записът не беше намерен.' })
        return true
      }
      if (readResult.reason === 'forbidden') {
        sendJsonResponse(res, 403, { ok: false, message: 'Нямаш право да маркираш това известие.' })
        return true
      }
      if (readResult.reason === 'wrong_status') {
        sendJsonResponse(res, 409, { ok: false, message: 'Поканата не е в статус accepted.' })
        return true
      }
    }

    // Broadcast to all open connections of this profile (marked or already_read).
    // already_read broadcast clears stale state in other tabs.
    sendToOpenProfileConnections(profileId, {
      type: 'friend_acceptance_notification_read',
      friendshipId,
    })
    sendJsonResponse(res, 200, { ok: true })
    return true
  }

  return false
}

async function handleChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const messagesMatch = /^\/api\/chat\/([^/]+)\/messages$/.exec(pathname)
  const readMatch = /^\/api\/chat\/([^/]+)\/read$/.exec(pathname)
  const attachmentMatch = /^\/api\/chat\/([^/]+)\/attachments\/([^/]+)$/.exec(pathname)
  const isPikaSupportStart = pathname === '/api/chat/pika-support/start'
  const isVipDmStart = pathname === '/api/chat/vip-dm/start'
  const isVipDmStartWithMessage = pathname === '/api/chat/vip-dm/start-with-message'

  if (
    pathname !== '/api/chat/conversations' &&
    messagesMatch === null &&
    readMatch === null &&
    attachmentMatch === null &&
    !isPikaSupportStart &&
    !isVipDmStart &&
    !isVipDmStartWithMessage
  ) {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null || session.profile.profileId === null) {
    sendJsonResponse(res, 401, {
      ok: false,
      message: 'Трябва да влезеш в профила си.',
    })
    return true
  }

  const profileId = session.profile.profileId

  if (isProfileInActiveGame(profileId)) {
    sendJsonResponse(res, 403, {
      ok: false,
      message: 'Чатът не е позволен по време на игра.',
    })
    return true
  }

  if (attachmentMatch !== null && req.method === 'GET') {
    return await handleChatAttachmentDownloadRequest(
      req,
      res,
      profileId,
      decodeURIComponent(attachmentMatch[1]).trim(),
      decodeURIComponent(attachmentMatch[2]).trim(),
    )
  }

  if (pathname === '/api/chat/conversations' && req.method === 'GET') {
    const onlineProfileIds = new Set<string>()
    for (const conn of Object.values(serverState.connections)) {
      if (conn.profileId !== null && conn.status === 'connected') onlineProfileIds.add(conn.profileId)
    }
    const includeArchived = new URL(req.url ?? '', 'http://localhost').searchParams.get('archived') === '1'
    sendJsonResponse(res, 200, {
      ok: true,
      conversations: chatStore.listConversations(profileId, onlineProfileIds, includeArchived),
    })
    return true
  }

  // Единствен entry point за СЪЗДАВАНЕ на служебен pika_support разговор —
  // authoritative проверката (initiator === configured official Pika.bg
  // profileId, ИЛИ role==='pika_team') живее в
  // chatStore.getOrCreatePikaSupportConversation, не тук — този handler само
  // подава сесийния profileId И role-derived флаг (isPikaTeamSupportChatSession,
  // authStore.ts), никога от client payload (session е единственият
  // източник за и двете).
  if (isPikaSupportStart && req.method === 'POST') {
    const body = await readJsonRequestBody(req, MAX_IMAGE_ATTACHMENT_JSON_BYTES)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Invalid request body.' })
      return true
    }

    const recipientProfileId = getStringField(body, 'recipientProfileId').trim()

    if (recipientProfileId.length === 0) {
      sendJsonResponse(res, 400, { ok: false, message: 'Липсва получател.' })
      return true
    }

    const result = chatStore.getOrCreatePikaSupportConversation(profileId, recipientProfileId, isPikaTeamSupportChatSession(session))

    if (!result.ok) {
      sendJsonResponse(res, 403, result)
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      friendshipId: result.friendshipId,
      conversation: result.conversation,
    })
    return true
  }

  if (isVipDmStart && req.method === 'POST') {
    const body = await readJsonRequestBody(req, MAX_IMAGE_ATTACHMENT_JSON_BYTES)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Invalid request body.' })
      return true
    }

    const recipientProfileId = getStringField(body, 'recipientProfileId').trim()

    if (recipientProfileId.length === 0) {
      sendJsonResponse(res, 400, { ok: false, message: 'Липсва получател.' })
      return true
    }

    const result = chatStore.getOrCreateVipDmConversation(profileId, recipientProfileId)

    if (!result.ok) {
      sendJsonResponse(res, 403, result)
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      friendshipId: result.friendshipId,
      conversation: result.conversation,
    })
    return true
  }

  // Атомарен start+send за ПЪРВОТО vip_dm съобщение (виж §4/§5 в task spec-а).
  // Единственият path, който може да СЪЗДАДЕ нов vip_dm ред след fix-а —
  // старият /vip-dm/start вече само чете съществуващи разговори.
  if (isVipDmStartWithMessage && req.method === 'POST') {
    const body = await readJsonRequestBody(req, MAX_IMAGE_ATTACHMENT_JSON_BYTES)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Invalid request body.' })
      return true
    }

    const recipientProfileId = getStringField(body, 'recipientProfileId').trim()

    if (recipientProfileId.length === 0) {
      sendJsonResponse(res, 400, { ok: false, message: 'Липсва получател.' })
      return true
    }

    // Global Topics-section mute guard (GLOBAL TOPICS MUTE брифа §1.D) —
    // route-level, засяга САМО този vip_dm-специфичен endpoint, никога
    // споделената chatStore.startVipDmConversationWithMessage/sendMessage
    // логика (за да не се докосне friend/pika_support, виж §8 в брифа).
    // Проверено ПРЕДИ каквато и да е attachment обработка, за да не се
    // хаби ресурс за заявка, която ще бъде отхвърлена.
    const vipDmStartMuteSnapshot = topicModerationStore.getSectionMuteSnapshot(profileId)
    if (vipDmStartMuteSnapshot.isMuted) {
      sendJsonResponse(res, 403, {
        ok: false,
        code: 'topic_muted',
        message: 'Временно сте заглушени в секция „Теми“.',
        mutedUntil: vipDmStartMuteSnapshot.mutedUntil ?? undefined,
        reason: vipDmStartMuteSnapshot.reason ?? undefined,
      })
      return true
    }

    // Файлът се записва на диска ПРЕДИ DB транзакцията (същия established
    // pattern като POST /api/chat/:friendshipId/messages) — ако последващият
    // get-or-create+insert се провали или се rollback-не (напр. VIP guard
    // отхвърли заявката, или insert-ът хвърли грешка), файлът се трие
    // веднага, за да не остане orphan нито DB ред без съобщение, нито
    // attachment файл без DB запис (виж §6 в task spec-а).
    const imageDataUrlField = body.imageDataUrl
    let attachmentInput: { storageFilename: string; width: number; height: number; byteSize: number; contentType: string } | null = null
    let writtenAttachmentFilename: string | null = null

    if (typeof imageDataUrlField === 'string' && imageDataUrlField.trim().length > 0) {
      const imageBuffer = decodeImageAttachmentDataUrl(imageDataUrlField)

      if (imageBuffer === null) {
        sendJsonResponse(res, 400, {
          ok: false,
          message: 'Поддържат се само JPEG, PNG и WebP снимки до 10 MB.',
        })
        return true
      }

      const processed = await createChatAttachmentWebp(imageBuffer)

      if (processed === null) {
        sendJsonResponse(res, 400, {
          ok: false,
          message: 'Поддържат се само JPEG, PNG и WebP снимки.',
        })
        return true
      }

      const storageFilename = `${randomUUID()}.webp`

      try {
        await writeWebpAttachmentFile(CHAT_ATTACHMENT_UPLOADS_PATH, storageFilename, processed.buffer)
        writtenAttachmentFilename = storageFilename
      } catch {
        sendJsonResponse(res, 500, {
          ok: false,
          message: 'Качването на снимката не бе успешно. Опитайте отново.',
        })
        return true
      }

      attachmentInput = {
        storageFilename,
        width: processed.width,
        height: processed.height,
        byteSize: processed.buffer.length,
        contentType: 'image/webp',
      }
    }

    let result: ReturnType<typeof chatStore.startVipDmConversationWithMessage>

    try {
      result = chatStore.startVipDmConversationWithMessage(
        profileId,
        recipientProfileId,
        getStringField(body, 'body'),
        attachmentInput,
      )
    } catch (error) {
      // DB транзакцията (get-or-create + insert съобщение) се провали ПОСЛЕ
      // вече записания файл на диска — изтрий го веднага, аналогично на
      // обикновения send handler по-долу.
      if (writtenAttachmentFilename !== null) {
        await deleteChatAttachmentFileByFilename(writtenAttachmentFilename)
      }

      throw error
    }

    if (!result.ok) {
      // Guard грешка (VIP/blocked/self/recipient_not_found) — nested
      // транзакцията вече е rollback-нала/не е създала нов vip_dm ред
      // (resolveVipDmFriendshipRow не INSERT-ва при неуспешна проверка), но
      // файлът на диска трябва да се изтрие изрично тук.
      if (writtenAttachmentFilename !== null) {
        await deleteChatAttachmentFileByFilename(writtenAttachmentFilename)
      }

      sendJsonResponse(res, 403, result)
      return true
    }

    const recipientProfileIdForNotification = result.conversation.friend.profileId
    const newMessageId = result.newMessage.messageId
    activityCounters.incrementChat('directChatVipDmMessages')

    if (recipientProfileIdForNotification !== null) {
      // friendshipId не е известен ПРЕДИ атомарната транзакция (get-or-create
      // се случва вътре в нея), затова обикновената isFirstUnreadMessage
      // (изисква извикване преди insert) не важи тук — виж
      // isFirstUnreadMessageAfterInsert в chatStore.ts.
      const shouldNotify = chatStore.isFirstUnreadMessageAfterInsert(
        recipientProfileIdForNotification,
        result.conversation.friendshipId,
      )
      sendChatNotificationToProfile({
        recipientProfileId: recipientProfileIdForNotification,
        friendshipId: result.conversation.friendshipId,
        senderProfileId: profileId,
        messageId: newMessageId,
        shouldNotify,
      })
    }

    sendJsonResponse(res, 200, {
      ok: true,
      friendshipId: result.conversation.friendshipId,
      conversation: result.conversation,
      messages: result.messages,
      newMessage: result.newMessage,
    })
    return true
  }

  if (readMatch !== null && req.method === 'POST') {
    const friendshipId = decodeURIComponent(readMatch[1]).trim()
    chatStore.markConversationRead(profileId, friendshipId)
    sendJsonResponse(res, 200, { ok: true })
    return true
  }

  if (messagesMatch !== null && req.method === 'GET') {
    const friendshipId = decodeURIComponent(messagesMatch[1]).trim()
    const result = chatStore.listMessages(profileId, friendshipId)

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      messages: result.messages,
    })
    return true
  }

  if (messagesMatch !== null && req.method === 'POST') {
    const friendshipId = decodeURIComponent(messagesMatch[1]).trim()
    const body = await readJsonRequestBody(req, MAX_IMAGE_ATTACHMENT_JSON_BYTES)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Invalid request body.',
      })
      return true
    }

    // Приятелство + blocking guard-ват само в chatStore.sendMessage, но за
    // снимка искаме да избегнем скъпата sharp обработка изцяло, ако
    // заявката очевидно ще бъде отхвърлена — затова кратка предварителна
    // проверка тук за самото участие във friendship-а (без status filter,
    // достатъчно бърза), не дублира валидацията в store-а, само spестява
    // работа при явно невалидни заявки.
    const imageDataUrlField = body.imageDataUrl
    let attachmentInput: { storageFilename: string; width: number; height: number; byteSize: number; contentType: string } | null = null
    let writtenAttachmentFilename: string | null = null

    const sendAuthorization = chatStore.canSendMessage(profileId, friendshipId)
    if (!sendAuthorization.ok) {
      sendJsonResponse(res, 400, sendAuthorization)
      return true
    }

    // Global Topics-section mute guard (GLOBAL TOPICS MUTE брифа §1.E) —
    // route-level, засяга САМО kind='vip_dm' разговори. friend/pika_support
    // изпращания през ТОЗИ ЖЕ handler НЕ се докосват — guard-ът е условен на
    // canonical conversation.kind lookup, не на споделената
    // chatStore.sendMessage вътрешна логика (§8 в брифа: friend/support
    // остават незасегнати).
    const conversationKindForMuteGuard = chatStore
      .listConversations(profileId)
      .find((c) => c.friendshipId === friendshipId)?.kind ?? null

    if (conversationKindForMuteGuard === 'vip_dm') {
      const vipDmSendMuteSnapshot = topicModerationStore.getSectionMuteSnapshot(profileId)
      if (vipDmSendMuteSnapshot.isMuted) {
        sendJsonResponse(res, 403, {
          ok: false,
          code: 'topic_muted',
          message: 'Временно сте заглушени в секция „Теми“.',
          mutedUntil: vipDmSendMuteSnapshot.mutedUntil ?? undefined,
          reason: vipDmSendMuteSnapshot.reason ?? undefined,
        })
        return true
      }
    }

    if (typeof imageDataUrlField === 'string' && imageDataUrlField.trim().length > 0) {
      const imageBuffer = decodeImageAttachmentDataUrl(imageDataUrlField)

      if (imageBuffer === null) {
        sendJsonResponse(res, 400, {
          ok: false,
          message: 'Поддържат се само JPEG, PNG и WebP снимки до 10 MB.',
        })
        return true
      }

      const processed = await createChatAttachmentWebp(imageBuffer)

      if (processed === null) {
        sendJsonResponse(res, 400, {
          ok: false,
          message: 'Поддържат се само JPEG, PNG и WebP снимки.',
        })
        return true
      }

      const storageFilename = `${randomUUID()}.webp`

      try {
        await writeWebpAttachmentFile(CHAT_ATTACHMENT_UPLOADS_PATH, storageFilename, processed.buffer)
        writtenAttachmentFilename = storageFilename
      } catch {
        sendJsonResponse(res, 500, {
          ok: false,
          message: 'Качването на снимката не бе успешно. Опитайте отново.',
        })
        return true
      }

      attachmentInput = {
        storageFilename,
        width: processed.width,
        height: processed.height,
        byteSize: processed.buffer.length,
        contentType: 'image/webp',
      }
    }

    // Снимка НА получателя ПРЕДИ insert-а на новото съобщение — иначе
    // isFirstUnreadMessage винаги би намерил поне самото ново съобщение.
    const recipientProfileIdBeforeSend = chatStore
      .listConversations(profileId)
      .find((c) => c.friendshipId === friendshipId)?.friend.profileId ?? null

    const shouldNotify = recipientProfileIdBeforeSend !== null
      && chatStore.isFirstUnreadMessage(recipientProfileIdBeforeSend, friendshipId)

    let result: ReturnType<typeof chatStore.sendMessage>

    try {
      result = chatStore.sendMessage(
        profileId,
        friendshipId,
        getStringField(body, 'body'),
        attachmentInput,
      )
    } catch (error) {
      // DB транзакцията се провали ПОСЛЕ вече записания файл на диска —
      // изтрий го веднага, за да не остане "осиротял" файл без DB запис.
      // Ако самото изтриване се провали (напр. transient FS грешка),
      // orphan scan job-ът (виж runChatAttachmentOrphanScan) ще го хване
      // по-късно — grace period-ът му е достатъчно дълъг да не удари
      // in-flight upload-и, а достатъчно кратък да чисти реални orphans.
      if (writtenAttachmentFilename !== null) {
        await deleteChatAttachmentFileByFilename(writtenAttachmentFilename)
      }

      throw error
    }

    if (!result.ok) {
      // Съобщението не беше записано (validation/guard грешка от store-а,
      // напр. blocking или "нито текст, нито снимка") — файлът вече е на
      // диска, трябва да се изтрие незабавно, за да не остане orphan.
      if (writtenAttachmentFilename !== null) {
        await deleteChatAttachmentFileByFilename(writtenAttachmentFilename)
      }

      sendJsonResponse(res, 400, result)
      return true
    }

    const recipientProfileId = result.conversation.friend.profileId
    const newMessageId = result.newMessage.messageId

    // Pika Team direct chat (kind='pika_support') е РАЗЛИЧЕН subsystem от
    // official support (supportStore) — виж monitoring audit §A.
    activityCounters.incrementChat(
      result.conversation.kind === 'pika_support' ? 'directChatPikaTeamMessages' : 'directChatFriendMessages',
    )

    if (recipientProfileId !== null) {
      sendChatNotificationToProfile({
        recipientProfileId,
        friendshipId,
        senderProfileId: profileId,
        messageId: newMessageId,
        shouldNotify,
      })
    }

    sendJsonResponse(res, 200, {
      ok: true,
      conversation: result.conversation,
      messages: result.messages,
      newMessage: result.newMessage,
    })
    return true
  }

  return false
}

// Защитен преглед/сваляне на chat attachment — НЕ минава през публичния
// handleUploadsRequest (виж бележката до CHAT_ATTACHMENT_UPLOADS_PATH).
// Guard-овете (сесия + friendship membership + attachment принадлежи на
// точно този friendship) живеят в chatStore.getAttachmentForDownload,
// извикани от profileId на текущата сесия — не е възможно да се подаде
// произволен profileId отвън.
async function handleChatAttachmentDownloadRequest(
  req: IncomingMessage,
  res: ServerResponse,
  profileId: string,
  friendshipId: string,
  filename: string,
): Promise<boolean> {
  if (!IMAGE_ATTACHMENT_FILENAME_PATTERN.test(filename)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидно име на файл.' })
    return true
  }

  const attachment = chatStore.getAttachmentForDownload(profileId, friendshipId, filename)

  if (attachment === null) {
    sendJsonResponse(res, 404, { ok: false, message: 'Файлът не беше намерен.' })
    return true
  }

  const filePath = join(CHAT_ATTACHMENT_UPLOADS_PATH, attachment.storageFilename)

  try {
    const fileStats = await stat(filePath)

    if (!fileStats.isFile()) {
      sendJsonResponse(res, 404, { ok: false, message: 'Файлът не беше намерен.' })
      return true
    }

    const fileBuffer = await readFile(filePath)
    const url = new URL(req.url ?? '', 'http://localhost')
    const isDownload = url.searchParams.get('download') !== null

    res.writeHead(200, {
      'Content-Type': attachment.contentType,
      // private (не public): браузърът може локално да кешира, но НЕ
      // споделен/proxy кеш — снимката е лично съдържание между двама
      // конкретни потребители, за разлика от avatar/gallery (immutable,
      // public — виж handleUploadsRequest), които са умишлено публични.
      'Cache-Control': 'private, max-age=86400',
      ...(isDownload
        ? { 'Content-Disposition': `attachment; filename="${attachment.storageFilename}"` }
        : {}),
    })
    res.end(fileBuffer)
    return true
  } catch {
    sendJsonResponse(res, 404, { ok: false, message: 'Файлът не беше намерен.' })
    return true
  }
}

// Модерация на "Публикации от Pika.bg" (бивш общ лайв чат, вече ограничен
// до официален канал) — САМО admin ИЛИ pika_team (isPikaAnnouncementAuthorSession),
// умишлено по-тесен от isLobbyChatModeratorSession (5 роли) — subadmin/
// chat_admin/top_chat_admin вече не трият тук (Публикации от Pika.bg брифа §3:
// "Не разширявай автоматично правата на други роли само защото преди са
// имали право да трият в общия Live Chat"). isPikaAnnouncementAuthorSession
// проверява ролята НА МОМЕНТА през жива JOIN към accounts, виж
// authStore.getSession. HTTP (не WS), нарочно — за да имаме прясна
// cookie-based сесийна проверка на всяко изтриване, а не роля кеширана само
// при WS handshake-а на дълготрайна връзка.
async function handleLobbyChatDeleteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const deleteMatch = /^\/api\/lobby-chat\/messages\/([^/]+)$/.exec(pathname)

  if (deleteMatch === null || req.method !== 'DELETE') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isPikaAnnouncementAuthorSession(session)) {
    sendJsonResponse(res, 403, {
      ok: false,
      message: 'Нямаш право да триеш публикации от Pika.bg.',
    })
    return true
  }

  const messageId = decodeURIComponent(deleteMatch[1]).trim()

  if (messageId.length === 0) {
    sendJsonResponse(res, 400, { ok: false, message: 'Липсва message ID.' })
    return true
  }

  // isPikaAnnouncementAuthorSession гарантира role === 'admin' | 'pika_team'.
  const result = lobbyChatStore.deleteMessage({
    messageId,
    actorAccountId: session.account.accountId,
    actorRoleAtDeletion: session.account.role as 'admin' | 'pika_team',
  })

  if (!result.ok && result.code === 'not_found') {
    sendJsonResponse(res, 404, { ok: false, message: 'Съобщението не беше намерено.' })
    return true
  }

  // 'already_deleted' и прясно успешно изтриване се третират еднакво навън —
  // идемпотентно: гарантирано вече не съществува в потока при връщане 200.
  if (result.ok) {
    lobbyChatLastAnnouncedDeletionEventSeq = lobbyChatStore.getMaxDeletionEventSeq()
    broadcastLobbyChatDeletionToLocalSubscribers(messageId)
  }

  sendJsonResponse(res, 200, { ok: true, messageId })
  return true
}

async function handleMissionsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const claimMatch = /^\/api\/missions\/([^/]+)\/claim$/.exec(pathname)

  if (pathname !== '/api/missions/daily' && claimMatch === null) {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null || session.profile.profileId === null) {
    sendJsonResponse(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
    return true
  }

  const profileId = session.profile.profileId
  const today = sofiaDateString()

  if (pathname === '/api/missions/daily' && req.method === 'GET') {
    missionStore.maybePromoteStaged()
    const missions = missionStore.getPlayerDailyMissions(profileId, today)
    const unclaimedCount = missionStore.getUnclaimedCompletedCount(profileId, today)
    sendJsonResponse(res, 200, { ok: true, missions, unclaimedCount, date: today })
    return true
  }

  if (claimMatch !== null && req.method === 'POST') {
    const missionId = decodeURIComponent(claimMatch[1] ?? '')
    const result = missionStore.claimMissionReward(profileId, missionId, today)

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    const missions = missionStore.getPlayerDailyMissions(profileId, today)
    const unclaimedCount = missionStore.getUnclaimedCompletedCount(profileId, today)
    sendJsonResponse(res, 200, { ok: true, rewardYellowCoins: result.rewardYellowCoins, missions, unclaimedCount })
    return true
  }

  return false
}

async function handleAdminMissionsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const activeMatch = /^\/api\/admin\/missions\/([^/]+)\/active$/.exec(pathname)
  const deleteMatch = /^\/api\/admin\/missions\/([^/]+)$/.exec(pathname)

  if (
    pathname !== '/api/admin/missions' &&
    activeMatch === null &&
    deleteMatch === null
  ) {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!isFullAdminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Нямаш достъп до админ мисиите.' })
    return true
  }

  if (pathname === '/api/admin/missions' && req.method === 'GET') {
    sendJsonResponse(res, 200, {
      ok: true,
      activeMissions: missionStore.listActiveMissions(),
      stagedMissions: missionStore.listStagedMissions(),
    })
    return true
  }

  if (pathname === '/api/admin/missions' && req.method === 'POST') {
    const body = await readJsonRequestBody(req)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Invalid request body.' })
      return true
    }

    const isStaged = body['isStaged'] === true
    const result = missionStore.upsertMission({
      missionId: getStringField(body, 'missionId') || null,
      missionType: getStringField(body, 'missionType') as MissionType,
      title: getStringField(body, 'title'),
      targetCount: getNumberField(body, 'targetCount') ?? 1,
      rewardYellowCoins: getNumberField(body, 'rewardYellowCoins') ?? 1000,
      isActive: true,
      isStaged,
      sortOrder: getNumberField(body, 'sortOrder') ?? 0,
    })

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      mission: result.mission,
      activeMissions: missionStore.listActiveMissions(),
      stagedMissions: missionStore.listStagedMissions(),
    })
    return true
  }

  if (activeMatch !== null && req.method === 'PATCH') {
    const body = await readJsonRequestBody(req)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Invalid request body.' })
      return true
    }

    const result = missionStore.setMissionActive(
      decodeURIComponent(activeMatch[1] ?? ''),
      body['isActive'] === true,
    )

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      mission: result.mission,
      activeMissions: missionStore.listActiveMissions(),
      stagedMissions: missionStore.listStagedMissions(),
    })
    return true
  }

  if (deleteMatch !== null && req.method === 'DELETE') {
    const result = missionStore.deleteMission(decodeURIComponent(deleteMatch[1] ?? ''))

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      activeMissions: missionStore.listActiveMissions(),
      stagedMissions: missionStore.listStagedMissions(),
    })
    return true
  }

  return false
}

// Admin payment statistics трябва да агрегират coin_purchase_ledger +
// vip_purchase_ledger (production root cause: VIP покупки бяха напълно
// невидими в "Плащания", защото coinPurchaseStore.getAdminPaymentStats()
// query-ва само coin таблицата). Двата store-а изчисляват period boundaries
// независимо (СЪЩИЯТ shared buildPeriodWhereClause от sofiaDayBounds.ts) —
// тук само сумираме count/totalCents per period, без нова timezone логика.
function combineAdminPaymentStats(
  coin: AdminPaymentStats,
  vip: AdminPaymentStats,
): AdminPaymentStats {
  function combinePeriod(a: PaymentPeriodStats, b: PaymentPeriodStats): PaymentPeriodStats {
    return { count: a.count + b.count, totalCents: a.totalCents + b.totalCents }
  }
  return {
    today: combinePeriod(coin.today, vip.today),
    yesterday: combinePeriod(coin.yesterday, vip.yesterday),
    last7days: combinePeriod(coin.last7days, vip.last7days),
    thisMonth: combinePeriod(coin.thisMonth, vip.thisMonth),
    allTime: combinePeriod(coin.allTime, vip.allTime),
  }
}

async function handleAdminStatsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/admin/stats') {
    return false
  }

  if (req.method !== 'GET') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  // "Информация" — read-only статистики, достъпно за admin И subadmin.
  if (!isAdminOrSubadminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Forbidden' })
    return true
  }

  const onlineCount = Object.values(serverState.connections).filter(
    (c) => c.status === 'connected' && socketRegistry.get(c.id)?.readyState === WebSocket.OPEN,
  ).length

  const registeredProfiles = playerProgressStore.countHumanProfiles()

  const paymentStats = combineAdminPaymentStats(
    coinPurchaseStore.getAdminPaymentStats(),
    vipPurchaseStore.getAdminPaymentStats(),
  )

  const visitors = siteVisitStore.getVisitorSummary()
  const viewLayout = siteVisitStore.getViewLayoutSummary()

  const userGamesPlayed = playerProgressStore.getUserGamesPlayedStats()
  const guestTrialGamesPlayed = guestTrialStore.getGamesPlayedStats()

  sendJsonResponse(res, 200, {
    ok: true,
    stats: {
      onlineCount,
      registeredProfiles,
      payments: paymentStats,
      visitors,
      viewLayout,
      gamesPlayed: {
        userGamesToday: userGamesPlayed.today,
        userGamesYesterday: userGamesPlayed.yesterday,
        guestTrialGamesToday: guestTrialGamesPlayed.today,
        guestTrialGamesYesterday: guestTrialGamesPlayed.yesterday,
      },
    },
  })
  return true
}

// Drill-down зад "днес"/"вчера" broяча в картата "Регистрирани профили"
// (Admin -> Информация) — reuse-ва СЪЩАТА auth политика и СЪЩИЯ
// getSofiaDayBoundsUtc-базиран period като handleAdminStatsRequest/
// countHumanProfiles, за да не се разминава броят на редовете с counter-а.
async function handleAdminRegisteredProfilesListRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/admin/registered-profiles') {
    return false
  }

  if (req.method !== 'GET') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  // Същия read-only "Информация" gate като handleAdminStatsRequest — admin И subadmin.
  if (!isAdminOrSubadminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Forbidden' })
    return true
  }

  const periodParam = new URLSearchParams(req.url?.split('?')[1] ?? '').get('period') ?? ''
  if (periodParam !== 'today' && periodParam !== 'yesterday') {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалиден параметър period. Използвай: today, yesterday.' })
    return true
  }

  const rows = playerProgressStore.listRegisteredProfilesForPeriod(periodParam)
  sendJsonResponse(res, 200, { ok: true, period: periodParam, rows })
  return true
}

// Parses a query param as a strict non-negative integer (decimal digits only, no
// leading sign, no decimal point, no trailing garbage). Returns the parsed number
// or null if the value is absent/empty (caller supplies the default), or 'invalid'
// if the string is present but malformed.
function parseStrictQueryInt(raw: string | null): number | null | 'invalid' {
  if (raw === null || raw === '') return null
  if (!/^\d+$/.test(raw)) return 'invalid'
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) return 'invalid'
  return n
}

async function handleAdminPaymentsListRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  requestUrl: URL,
): Promise<boolean> {
  if (pathname !== '/api/admin/payments') {
    return false
  }

  if (req.method !== 'GET') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!session) {
    sendJsonResponse(res, 401, { ok: false, message: 'Unauthorized' })
    return true
  }

  // "Информация" — read-only плащания, достъпно за admin И subadmin.
  if (!isAdminOrSubadminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Forbidden' })
    return true
  }

  const rawPeriod = requestUrl.searchParams.get('period') ?? ''
  if (!(ADMIN_PAYMENT_PERIODS as readonly string[]).includes(rawPeriod)) {
    sendJsonResponse(res, 400, {
      ok: false,
      errorCode: 'INVALID_PERIOD',
      message: `Invalid period "${rawPeriod}". Valid values: ${ADMIN_PAYMENT_PERIODS.join(', ')}.`,
    })
    return true
  }

  const parsedLimit  = parseStrictQueryInt(requestUrl.searchParams.get('limit'))
  const parsedOffset = parseStrictQueryInt(requestUrl.searchParams.get('offset'))

  if (parsedLimit === 'invalid') {
    sendJsonResponse(res, 400, {
      ok: false,
      errorCode: 'INVALID_LIMIT',
      message: 'limit must be a positive integer (1–100).',
    })
    return true
  }

  if (parsedOffset === 'invalid') {
    sendJsonResponse(res, 400, {
      ok: false,
      errorCode: 'INVALID_OFFSET',
      message: 'offset must be a non-negative integer.',
    })
    return true
  }

  // null → param absent → use default
  const limitRaw = parsedLimit ?? 50

  if (limitRaw === 0) {
    sendJsonResponse(res, 400, {
      ok: false,
      errorCode: 'INVALID_LIMIT',
      message: 'limit must be a positive integer (1–100).',
    })
    return true
  }

  const limit  = Math.min(limitRaw, 100)
  const offset = parsedOffset ?? 0

  // Combined admin payments (root cause: VIP покупки бяха невидими, само
  // coin_purchase_ledger се четеше тук). Global top-N pagination correctness:
  // взимаме от ВСЕКИ source най-много (offset+limit) реда, започвайки от 0
  // (не coin's собствен SQL offset/limit directно — combined sort-order-ът
  // може да измести кои coin/VIP редове принадлежат на коя combined page).
  // Merge-ваме, сортираме по creditedAt DESC, slice(offset, offset+limit).
  // Достатъчно за коректен global top-N без да зареждаме ЦЯЛАТА period
  // история на всяка заявка (какъвто беше предишният limit:100_000 подход).
  const period = rawPeriod as (typeof ADMIN_PAYMENT_PERIODS)[number]
  const topNFetchLimit = offset + limit
  const coinTopN = coinPurchaseStore.getAdminPaymentListByPeriod({ period, limit: topNFetchLimit, offset: 0 })
  const vipRowsForPeriod = vipPurchaseStore.getAdminPaymentListByPeriod({ period })
  const vipTopN = vipRowsForPeriod
    .slice()
    .sort((a, b) => (Date.parse(b.creditedAt ?? '') || 0) - (Date.parse(a.creditedAt ?? '') || 0))
    .slice(0, topNFetchLimit)

  const combinedRows: AdminPaymentListRow[] = [...coinTopN.rows, ...vipTopN].sort((a, b) => {
    const aTime = a.creditedAt ? Date.parse(a.creditedAt) : 0
    const bTime = b.creditedAt ? Date.parse(b.creditedAt) : 0
    if (bTime !== aTime) return bTime - aTime
    return b.purchaseId.localeCompare(a.purchaseId)
  })

  const pageRows = combinedRows.slice(offset, offset + limit)

  // total/totalsByCurrency остават ЦЕЛИЯТ period (coin.total вече е whole-
  // period count от summary заявката вътре в coinPurchaseStore, независимо
  // от LIMIT-а подаден тук; vipRowsForPeriod е пълният VIP period набор).
  const total = coinTopN.total + vipRowsForPeriod.length
  const combinedTotalsByCurrency: Record<string, number> = { ...coinTopN.totalsByCurrency }
  for (const vipRow of vipRowsForPeriod) {
    combinedTotalsByCurrency[vipRow.currency] = (combinedTotalsByCurrency[vipRow.currency] ?? 0) + vipRow.priceCents
  }

  sendJsonResponse(res, 200, {
    ok: true,
    period: rawPeriod,
    purchases: pageRows,
    pagination: {
      limit,
      offset,
      total,
      hasMore: offset + pageRows.length < total,
    },
    summary: {
      totalsByCurrency: combinedTotalsByCurrency,
    },
  })
  return true
}

async function handleAdminPaymentDetailRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/admin\/payments\/([^/]+)$/.exec(pathname)
  if (!match) return false

  if (req.method !== 'GET') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!session) {
    sendJsonResponse(res, 401, { ok: false, message: 'Unauthorized' })
    return true
  }

  // "Информация" — read-only детайли на плащане, достъпно за admin И subadmin.
  if (!isAdminOrSubadminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Forbidden' })
    return true
  }

  const rawPurchaseId = match[1] ?? ''
  let purchaseId: string
  try {
    purchaseId = decodeURIComponent(rawPurchaseId)
  } catch {
    sendJsonResponse(res, 400, { ok: false, message: 'Invalid purchaseId.' })
    return true
  }

  // purchaseId must be non-empty after path extraction; normalizeId trims+slices inside the store
  if (!purchaseId) {
    sendJsonResponse(res, 400, { ok: false, message: 'Missing purchaseId.' })
    return true
  }

  // Detail lookup различава coin/VIP чрез explicit source в резултата, НЕ
  // purchase_id prefix (двата store-а генерират UUID-и независимо, без общ
  // namespace contract) — опитваме coin store-а първо (established primary
  // path), после VIP store-а като fallback.
  //
  // Fallback-ът (не source query param от клиента) е АРХИТЕКТУРНО нужен, не
  // просто удобен избор: /admin/payments/:purchaseId е bookmarkable/
  // refresh-safe route (виж navigateFromPath -> showAdminPaymentDetailPanel
  // в createLobbyFlowController.ts) — при директно отваряне на този URL
  // (нов таб, refresh, споделен линк) няма в паметта list row, от който
  // клиентът да прочете source. Backend-ът трябва да може да resolve-не
  // purchaseId САМОСТОЯТЕЛНО и в тоя случай, значи fallback логиката тук
  // остава задължителна дори ако добавим source hint за click-from-list
  // пътя — добавянето му би било чиста performance micro-optimization
  // (спестява един безполезен PRIMARY KEY lookup на грешната таблица,
  // практически безплатен), не premahva нуждата от fallback-а. Затова НЕ е
  // добавен — не решава реален проблем, добавя query param + client wiring
  // само за да отпадне fallback логика, която все пак трябва да остане.
  const detail = coinPurchaseStore.getAdminPaymentDetail(purchaseId) ?? vipPurchaseStore.getAdminPaymentDetail(purchaseId)
  if (!detail) {
    sendJsonResponse(res, 404, { ok: false, message: 'Плащането не е намерено.' })
    return true
  }

  sendJsonResponse(res, 200, { ok: true, purchase: detail })
  return true
}

async function handleAdminVisitorSourcesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  requestUrl: URL,
): Promise<boolean> {
  if (pathname !== '/api/admin/visitor-sources') {
    return false
  }

  if (req.method !== 'GET') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  // "Информация" — read-only visitor sources, достъпно за admin И subadmin.
  if (!isAdminOrSubadminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Forbidden' })
    return true
  }

  const VALID_PERIODS = ['today', 'yesterday', '7d', '30d'] as const
  const VALID_TYPES   = ['all', 'guest', 'registered'] as const
  const VALID_DEVICES = ['all', 'mobile', 'desktop', 'tablet', 'unknown'] as const
  const VALID_OS      = ['all', 'android', 'ios', 'windows', 'macos', 'linux', 'chromeos', 'unknown'] as const

  const rawPeriod = requestUrl.searchParams.get('period') ?? 'today'
  const rawType   = requestUrl.searchParams.get('type')   ?? 'all'
  const rawDevice = requestUrl.searchParams.get('device') ?? 'all'
  const rawOs     = requestUrl.searchParams.get('os')     ?? 'all'

  const period = (VALID_PERIODS as readonly string[]).includes(rawPeriod)
    ? (rawPeriod as typeof VALID_PERIODS[number])
    : 'today'
  const type = (VALID_TYPES as readonly string[]).includes(rawType)
    ? (rawType as typeof VALID_TYPES[number])
    : 'all'
  const device = (VALID_DEVICES as readonly string[]).includes(rawDevice)
    ? (rawDevice as VisitorDeviceFilter)
    : 'all'
  const os = (VALID_OS as readonly string[]).includes(rawOs)
    ? (rawOs as VisitorOsFilter)
    : 'all'

  const result = siteVisitStore.getVisitorSources({ period, type, device, os })
  sendJsonResponse(res, 200, { ok: true, ...result })
  return true
}

async function handleAdminVisitorsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  requestUrl: URL,
): Promise<boolean> {
  if (pathname !== '/api/admin/visitors') {
    return false
  }

  if (req.method !== 'GET') {
    sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
    return true
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  // "Информация" — read-only посетители, достъпно за admin И subadmin.
  if (!isAdminOrSubadminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Forbidden' })
    return true
  }

  const VALID_PERIODS = ['today', 'yesterday', '7d', '30d'] as const
  const VALID_TYPES = ['all', 'guest', 'registered'] as const
  const VALID_DEVICES = ['all', 'mobile', 'desktop', 'tablet', 'unknown'] as const
  const VALID_OS = ['all', 'android', 'ios', 'windows', 'macos', 'linux', 'chromeos', 'unknown'] as const

  const rawPeriod = requestUrl.searchParams.get('period') ?? 'today'
  const rawType = requestUrl.searchParams.get('type') ?? 'all'
  const rawDevice = requestUrl.searchParams.get('device') ?? 'all'
  const rawOs = requestUrl.searchParams.get('os') ?? 'all'
  const rawLimit = parseInt(requestUrl.searchParams.get('limit') ?? '50', 10)
  const rawOffset = parseInt(requestUrl.searchParams.get('offset') ?? '0', 10)

  const period = (VALID_PERIODS as readonly string[]).includes(rawPeriod)
    ? (rawPeriod as typeof VALID_PERIODS[number])
    : 'today'
  const type = (VALID_TYPES as readonly string[]).includes(rawType)
    ? (rawType as typeof VALID_TYPES[number])
    : 'all'
  const device = (VALID_DEVICES as readonly string[]).includes(rawDevice)
    ? (rawDevice as VisitorDeviceFilter)
    : 'all'
  const os = (VALID_OS as readonly string[]).includes(rawOs)
    ? (rawOs as VisitorOsFilter)
    : 'all'
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0

  const result = siteVisitStore.getVisitorList({ period, type, device, os, limit, offset })

  sendJsonResponse(res, 200, { ok: true, ...result })
  return true
}

async function handleAdminDailyRewardsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const deleteMatch = /^\/api\/admin\/daily-rewards\/([^/]+)$/.exec(pathname)

  if (pathname !== '/api/admin/daily-rewards' && deleteMatch === null) {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  // "Настройки" — само пълен admin.
  if (!isFullAdminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Forbidden' })
    return true
  }

  if (pathname === '/api/admin/daily-rewards' && req.method === 'GET') {
    sendJsonResponse(res, 200, {
      ok: true,
      activeTiers: dailyRewardsStore.listActiveTiers(),
      stagedTiers: dailyRewardsStore.listStagedTiers(),
    })
    return true
  }

  if (pathname === '/api/admin/daily-rewards' && req.method === 'POST') {
    const body = await readJsonRequestBody(req)
    if (!isRecord(body)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалидно тяло.' })
      return true
    }
    const amount = getNumberField(body, 'yellowCoinsAmount')
    if (amount === null) {
      sendJsonResponse(res, 400, { ok: false, message: 'Липсва yellowCoinsAmount.' })
      return true
    }
    const result = dailyRewardsStore.addStagedTier(amount)
    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }
    sendJsonResponse(res, 200, {
      ok: true,
      activeTiers: dailyRewardsStore.listActiveTiers(),
      stagedTiers: dailyRewardsStore.listStagedTiers(),
    })
    return true
  }

  if (deleteMatch !== null && req.method === 'DELETE') {
    const tierId = decodeURIComponent(deleteMatch[1] ?? '')
    const result = dailyRewardsStore.removeStagedTier(tierId)
    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }
    sendJsonResponse(res, 200, {
      ok: true,
      activeTiers: dailyRewardsStore.listActiveTiers(),
      stagedTiers: dailyRewardsStore.listStagedTiers(),
    })
    return true
  }

  sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
  return true
}

async function handlePublicRoomsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/rooms' || req.method !== 'GET') return false
  sendJsonResponse(res, 200, { ok: true, rooms: matchRoomsStore.listRooms() })
  return true
}

async function handleGuestTrialStatusRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/guest/trial-status' || req.method !== 'GET') return false

  const existingGuestId = getGuestIdFromCookieHeader(req.headers.cookie)
  const ipHash = req.socket.remoteAddress ? hashGuestIdentitySignal(req.socket.remoteAddress) : null
  const userAgentHash = req.headers['user-agent'] ? hashGuestIdentitySignal(req.headers['user-agent']) : null

  const session = guestTrialStore.getOrCreateSession(existingGuestId, ipHash, userAgentHash)

  sendJsonResponse(
    res,
    200,
    {
      ok: true,
      gamesUsed: session.gamesUsed,
      remaining: session.remaining,
      maxGames: GUEST_TRIAL_MAX_GAMES,
      stake: GUEST_TRIAL_STAKE,
    },
    existingGuestId === session.guestId ? {} : { 'Set-Cookie': createGuestIdCookieHeader(session.guestId) },
  )
  return true
}

async function handleAdminMatchRoomsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const deleteMatch = /^\/api\/admin\/rooms\/(\d+)$/.exec(pathname)

  if (pathname !== '/api/admin/rooms' && deleteMatch === null) return false

  const session = authStore.getSession(getSessionTokenFromCookieHeader(req.headers.cookie))
  // "Настройки" (rooms) — само пълен admin.
  if (!isFullAdminSession(session)) {
    sendJsonResponse(res, 403, { ok: false, message: 'Forbidden' })
    return true
  }

  if (pathname === '/api/admin/rooms' && req.method === 'GET') {
    sendJsonResponse(res, 200, { ok: true, rooms: matchRoomsStore.listRooms() })
    return true
  }

  if (pathname === '/api/admin/rooms' && req.method === 'POST') {
    const body = await readJsonRequestBody(req)
    const bodyRecord = isRecord(body) ? body : {}
    const stakeAmount = getNumberField(bodyRecord, 'stakeAmount') ?? 0
    const minLevel = getNumberField(bodyRecord, 'minLevel') ?? 1
    const prizeAmount = getNumberField(bodyRecord, 'prizeAmount') ?? 0
    const isEnabled = bodyRecord['isEnabled'] !== false

    const result = matchRoomsStore.upsertRoom({ stakeAmount, minLevel, prizeAmount, isEnabled })
    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    setSupportedMatchStakes(matchRoomsStore.getEnabledStakes())
    setMatchPrizeResolver((stake) => matchRoomsStore.getPrizeAmount(stake))
    sendJsonResponse(res, 200, { ok: true, room: result.room, rooms: matchRoomsStore.listRooms() })
    return true
  }

  if (deleteMatch !== null && req.method === 'DELETE') {
    const stakeAmount = Number(deleteMatch[1])
    const deleted = matchRoomsStore.deleteRoom(stakeAmount)
    if (!deleted) {
      sendJsonResponse(res, 404, { ok: false, message: 'Стаята не беше намерена.' })
      return true
    }
    setSupportedMatchStakes(matchRoomsStore.getEnabledStakes())
    setMatchPrizeResolver((stake) => matchRoomsStore.getPrizeAmount(stake))
    sendJsonResponse(res, 200, { ok: true, rooms: matchRoomsStore.listRooms() })
    return true
  }

  sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
  return true
}

type SupportAttachmentUploadResult =
  | {
      ok: true
      attachmentInput: {
        storageFilename: string
        width: number
        height: number
        byteSize: number
        contentType: string
      } | null
      writtenAttachmentFilename: string | null
    }
  | { ok: false; statusCode: number; message: string }

async function createSupportAttachmentUpload(
  imageDataUrlField: unknown,
): Promise<SupportAttachmentUploadResult> {
  if (imageDataUrlField === undefined || imageDataUrlField === null) {
    return { ok: true, attachmentInput: null, writtenAttachmentFilename: null }
  }

  if (typeof imageDataUrlField !== 'string' || imageDataUrlField.trim().length === 0) {
    return { ok: false, statusCode: 400, message: 'Невалидна снимка.' }
  }

  const imageBuffer = decodeImageAttachmentDataUrl(imageDataUrlField)

  if (imageBuffer === null) {
    return { ok: false, statusCode: 400, message: 'Поддържат се само JPEG, PNG и WebP снимки до 10 MB.' }
  }

  const processed = await processImageAttachmentToWebp(imageBuffer, { enforceSourcePixelLimit: true })

  if (processed === null) {
    return { ok: false, statusCode: 400, message: 'Снимката не може да бъде обработена.' }
  }

  const storageFilename = `${randomUUID()}.webp`

  try {
    await writeWebpAttachmentFile(SUPPORT_ATTACHMENT_UPLOADS_PATH, storageFilename, processed.buffer)
  } catch {
    return { ok: false, statusCode: 500, message: 'Снимката не можа да бъде записана.' }
  }

  return {
    ok: true,
    writtenAttachmentFilename: storageFilename,
    attachmentInput: {
      storageFilename,
      width: processed.width,
      height: processed.height,
      byteSize: processed.buffer.length,
      contentType: 'image/webp',
    },
  }
}

async function handleSupportAttachmentDownloadRequest(
  req: IncomingMessage,
  res: ServerResponse,
  viewerProfileId: string,
  isFullAdmin: boolean,
  filename: string,
): Promise<boolean> {
  if (!IMAGE_ATTACHMENT_FILENAME_PATTERN.test(filename)) {
    sendJsonResponse(res, 400, { ok: false, message: 'Невалидно име на файл.' })
    return true
  }

  const attachment = supportStore.getAttachmentForDownload(viewerProfileId, isFullAdmin, filename)

  if (attachment === null) {
    sendJsonResponse(res, 404, { ok: false, message: 'Файлът не беше намерен.' })
    return true
  }

  const filePath = join(SUPPORT_ATTACHMENT_UPLOADS_PATH, attachment.storageFilename)

  try {
    const fileStats = await stat(filePath)

    if (!fileStats.isFile()) {
      sendJsonResponse(res, 404, { ok: false, message: 'Файлът не беше намерен.' })
      return true
    }

    const fileBuffer = await readFile(filePath)
    const url = new URL(req.url ?? '', 'http://localhost')
    const isDownload = url.searchParams.get('download') !== null

    res.writeHead(200, {
      'Content-Type': attachment.contentType,
      'Cache-Control': 'private, max-age=86400',
      ...(isDownload
        ? { 'Content-Disposition': `attachment; filename="${attachment.storageFilename}"` }
        : {}),
    })
    res.end(fileBuffer)
    return true
  } catch {
    sendJsonResponse(res, 404, { ok: false, message: 'Файлът не беше намерен.' })
    return true
  }
}

async function handleSupportRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/support')) return false

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)
  const supportAttachmentMatch = /^\/api\/support\/attachments\/([^/]+)$/.exec(pathname)

  if (supportAttachmentMatch !== null && req.method === 'GET') {
    if (!session || session.profile.profileId === null) {
      sendJsonResponse(res, 401, { ok: false, message: 'Не си влязъл в профила си.' })
      return true
    }

    return await handleSupportAttachmentDownloadRequest(
      req,
      res,
      session.profile.profileId,
      isFullAdminSession(session),
      decodeURIComponent(supportAttachmentMatch[1]).trim(),
    )
  }

  // GET /api/support/messages — user gets own conversation
  if (pathname === '/api/support/messages' && req.method === 'GET') {
    if (!session || session.profile.profileId === null) {
      sendJsonResponse(res, 401, { ok: false, message: 'Не си влязъл в профила си.' })
      return true
    }
    const profileId = session.profile.profileId
    const messages = supportStore.getMessages(profileId)
    supportStore.markReadByUser(profileId)
    const unreadCount = 0
    sendJsonResponse(res, 200, { ok: true, messages, unreadCount })
    return true
  }

  // POST /api/support/messages — user sends message
  if (pathname === '/api/support/messages' && req.method === 'POST') {
    if (!session || session.profile.profileId === null) {
      sendJsonResponse(res, 401, { ok: false, message: 'Не си влязъл в профила си.' })
      return true
    }
    const profileId = session.profile.profileId
    let parsed: unknown
    try {
      parsed = await readJsonRequestBody(req, MAX_IMAGE_ATTACHMENT_JSON_BYTES)
    } catch (error) {
      const message = error instanceof Error && error.message === 'Request body is too large.'
        ? 'Заявката е твърде голяма.'
        : 'Невалидна заявка.'
      sendJsonResponse(res, message === 'Заявката е твърде голяма.' ? 413 : 400, { ok: false, message })
      return true
    }

    if (!isRecord(parsed)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалидна заявка.' })
      return true
    }

    // Honeypot — bots fill hidden fields
    if (getStringField(parsed, 'website')) {
      sendJsonResponse(res, 200, { ok: true })
      return true
    }

    // Account age — must be at least 10 minutes old
    const accountAgeMs = Date.now() - new Date(session.account.createdAt).getTime()
    const ACCOUNT_AGE_REQUIRED_MS = 10 * 60 * 1000
    if (accountAgeMs < ACCOUNT_AGE_REQUIRED_MS) {
      const remainingMs = ACCOUNT_AGE_REQUIRED_MS - accountAgeMs
      const remainingMinutes = Math.ceil(remainingMs / 60000)
      sendJsonResponse(res, 403, { ok: false, code: 'account_too_new', remainingMinutes })
      return true
    }

    // Rate limit — max 5 user messages per hour, only if admin hasn't replied yet
    if (!supportStore.hasAdminReply(profileId)) {
      const recentCount = supportStore.countRecentMessages(profileId, 60)
      if (recentCount >= 5) {
        sendJsonResponse(res, 429, { ok: false, code: 'rate_limited', message: 'Достигнахте лимита от 5 съобщения на час. Изчакайте отговор от екипа.' })
        return true
      }
    }

    const text = getStringField(parsed, 'body').trim()
    if (text.length > 2000) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалидно съобщение.' })
      return true
    }
    const upload = await createSupportAttachmentUpload(parsed.imageDataUrl)
    if (!upload.ok) {
      sendJsonResponse(res, upload.statusCode, { ok: false, message: upload.message })
      return true
    }
    if (text.length === 0 && upload.attachmentInput === null) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалидно съобщение.' })
      return true
    }

    let message: SupportMessageSnapshot
    try {
      message = supportStore.sendUserMessage(profileId, text, upload.attachmentInput)
    } catch (error) {
      if (upload.writtenAttachmentFilename !== null) {
        await deleteSupportAttachmentFileByFilename(upload.writtenAttachmentFilename)
      }
      throw error
    }
    activityCounters.incrementChat('officialSupportMessages')
    const messages = supportStore.getMessages(profileId)
    sendJsonResponse(res, 200, { ok: true, message, messages })
    return true
  }

  // GET /api/support/unread — unread count (admin gets total, user gets own)
  if (pathname === '/api/support/unread' && req.method === 'GET') {
    if (!session || session.profile.profileId === null) {
      sendJsonResponse(res, 200, { ok: true, unreadCount: 0 })
      return true
    }
    // session вече е стеснен до non-null по-горе — директна проверка на ролята
    // (isFullAdminSession тук би дал `never` в false клона, защото TS вече знае
    // че session е AuthSessionSnapshot и type predicate-ът го изключва изцяло).
    const unreadCount = session.account.role === 'admin'
      ? supportStore.getTotalUnreadForAdmin()
      : supportStore.getUnreadCountForUser(session.profile.profileId)
    sendJsonResponse(res, 200, { ok: true, unreadCount })
    return true
  }

  // GET /api/support/admin/conversations — admin sees all (чат с поддръжката — само пълен admin)
  if (pathname === '/api/support/admin/conversations' && req.method === 'GET') {
    if (!isFullAdminSession(session)) {
      sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
      return true
    }
    const conversations = supportStore.getAllConversations((profileId) => {
      const p = playerProgressStore.getPublicProfile(profileId)
      if (!p) return null
      return { displayName: p.displayName, avatarUrl: p.avatarUrl }
    })
    const totalUnread = supportStore.getTotalUnreadForAdmin()
    sendJsonResponse(res, 200, { ok: true, conversations, totalUnread })
    return true
  }

  // GET /api/support/admin/messages/:profileId — admin reads thread (само пълен admin)
  if (pathname.startsWith('/api/support/admin/messages/') && req.method === 'GET') {
    if (!isFullAdminSession(session)) {
      sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
      return true
    }
    const profileId = pathname.replace('/api/support/admin/messages/', '')
    const messages = supportStore.getMessages(profileId)
    supportStore.markReadByAdmin(profileId)
    sendJsonResponse(res, 200, { ok: true, messages })
    return true
  }

  // POST /api/support/admin/reply — admin replies (само пълен admin)
  if (pathname === '/api/support/admin/reply' && req.method === 'POST') {
    if (!isFullAdminSession(session)) {
      sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
      return true
    }
    let parsed: unknown
    try {
      parsed = await readJsonRequestBody(req, MAX_IMAGE_ATTACHMENT_JSON_BYTES)
    } catch (error) {
      const message = error instanceof Error && error.message === 'Request body is too large.'
        ? 'Заявката е твърде голяма.'
        : 'Невалидна заявка.'
      sendJsonResponse(res, message === 'Заявката е твърде голяма.' ? 413 : 400, { ok: false, message })
      return true
    }

    if (!isRecord(parsed)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалидни данни.' })
      return true
    }

    const profileId = getStringField(parsed, 'profileId').trim()
    const text = getStringField(parsed, 'body').trim()
    if (!profileId || text.length > 2000) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалидни данни.' })
      return true
    }
    const upload = await createSupportAttachmentUpload(parsed.imageDataUrl)
    if (!upload.ok) {
      sendJsonResponse(res, upload.statusCode, { ok: false, message: upload.message })
      return true
    }
    if (text.length === 0 && upload.attachmentInput === null) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалидни данни.' })
      return true
    }

    let message: SupportMessageSnapshot | null
    try {
      message = supportStore.sendAdminReply(profileId, text, upload.attachmentInput)
    } catch (error) {
      if (upload.writtenAttachmentFilename !== null) {
        await deleteSupportAttachmentFileByFilename(upload.writtenAttachmentFilename)
      }
      throw error
    }
    if (!message) {
      if (upload.writtenAttachmentFilename !== null) {
        await deleteSupportAttachmentFileByFilename(upload.writtenAttachmentFilename)
      }
      sendJsonResponse(res, 404, { ok: false, message: 'Потребителят няма съобщения.' })
      return true
    }
    activityCounters.incrementChat('officialSupportMessages')
    const messages = supportStore.getMessages(profileId)
    sendJsonResponse(res, 200, { ok: true, message, messages })
    return true
  }

  // POST /api/support/admin/conversations/:profileId/archive — admin archives thread (само пълен admin)
  if (pathname.match(/^\/api\/support\/admin\/conversations\/[^/]+\/archive$/) && req.method === 'POST') {
    if (!isFullAdminSession(session)) {
      sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
      return true
    }
    const profileId = pathname.replace('/api/support/admin/conversations/', '').replace('/archive', '')
    if (!profileId) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалиден profileId.' })
      return true
    }
    supportStore.archiveConversation(profileId)
    sendJsonResponse(res, 200, { ok: true })
    return true
  }

  // DELETE /api/support/admin/conversations/:profileId — admin hard-deletes thread (само пълен admin)
  if (pathname.startsWith('/api/support/admin/conversations/') && req.method === 'DELETE') {
    if (!isFullAdminSession(session)) {
      sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
      return true
    }
    const profileId = pathname.replace('/api/support/admin/conversations/', '')
    if (!profileId) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалиден profileId.' })
      return true
    }
    supportStore.deleteConversation(profileId)
    sendJsonResponse(res, 200, { ok: true })
    return true
  }

  // DELETE /api/support/messages — user deletes own conversation
  if (pathname === '/api/support/messages' && req.method === 'DELETE') {
    if (!session || session.profile.profileId === null) {
      sendJsonResponse(res, 401, { ok: false, message: 'Не си влязъл в профила си.' })
      return true
    }
    supportStore.deleteConversation(session.profile.profileId)
    sendJsonResponse(res, 200, { ok: true })
    return true
  }

  return false
}

async function handleDailyRewardsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/daily-rewards' && pathname !== '/api/daily-rewards/claim') {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (!session?.profile.profileId) {
    sendJsonResponse(res, 401, { ok: false, message: 'Не си влязъл в профила си.' })
    return true
  }

  const profileId = session.profile.profileId

  if (pathname === '/api/daily-rewards' && req.method === 'GET') {
    const tiers = dailyRewardsStore.listTiersWithClaimStatus(profileId)
    sendJsonResponse(res, 200, { ok: true, tiers })
    return true
  }

  if (pathname === '/api/daily-rewards/claim' && req.method === 'POST') {
    const body = await readJsonRequestBody(req)
    if (!isRecord(body)) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалидно тяло.' })
      return true
    }
    const tierId = typeof body['tierId'] === 'string' ? body['tierId'].trim() : null
    if (!tierId) {
      sendJsonResponse(res, 400, { ok: false, message: 'Липсва tierId.' })
      return true
    }
    const result = dailyRewardsStore.claimReward(profileId, tierId)
    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }
    const tiers = dailyRewardsStore.listTiersWithClaimStatus(profileId)
    const updatedProfile = playerProgressStore.getPublicProfile(profileId)
    sendJsonResponse(res, 200, {
      ok: true,
      yellowCoinsAwarded: result.yellowCoinsAwarded,
      newBalance: updatedProfile?.yellowCoinsBalance ?? null,
      tiers,
    })
    return true
  }

  sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed' })
  return true
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const origin = req.headers.origin

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
  }

  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  // Monitoring-only: fixed, finite pathname-prefix категория, изчислена ВЕДНЪЖ
  // тук — не пипа dispatch веригата надолу (виж monitoring audit §6/§14).
  activityCounters.incrementHttpCategory(classifyHttpRequestPath(requestUrl.pathname))

  // Guard-нат вътрешно (флаг + loopback, виж localTournamentTestModeGuard.ts) —
  // извън strictly-local режима pathname проверката е единственият разход и
  // отговорът е 404, идентично на непознат route.
  if (await handleLocalTournamentTestRequest(req, res, requestUrl.pathname, localTournamentTestService)) {
    return
  }

  if (await handleUploadsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (requestUrl.pathname === '/health') {
    const gameRuntimeHealth = {
      activeRooms: Object.keys(serverState.rooms).length,
      roomsByPhase: countServerRoomsByPhase(serverState.rooms),
    }
    const tickHealth = gameWorkerTickOrchestrator.getHealth()
    const poolHealth = gameWorkerPool?.getHealth() ?? null
    const lifecycleState =
      gameWorkerLifecycleClient?.getState() ?? poolHealth?.state ?? 'failed'
    const lifecycleOk =
      gameWorkerLifecycleClient !== null
        ? lifecycleState === 'ready'
        : poolHealth?.state === 'ready'

    const trainingRecorderMetrics = trainingRecorder.getMetrics()

    sendJsonResponse(res, 200, {
      ok: true,
      service: 'belot-v2-server',
      matchmaking: {
        waitMs: MATCHMAKING_WAIT_MS,
        queuedPlayersByStake: getQueueCountsByStake(),
      },
      gameRuntime: gameRuntimeHealth,
      gameWorkerTick: {
        mode: tickHealth.mode,
        inFlight: tickHealth.inFlight,
        isShuttingDown: tickHealth.isShuttingDown,
        trackedRevisionRooms: roomRevisionRegistry.getTrackedRoomCount(),
      },
      gameWorkerLifecycle: {
        ok: lifecycleOk,
        state: lifecycleState,
        workerId: startupWorkerHealth?.workerId ?? null,
        startupPingMs: startupWorkerPingMs,
        startedAt: startupWorkerHealth?.startedAt ?? null,
        activeRooms: startupWorkerHealth?.activeRooms ?? null,
      },
      tournamentScheduler: tournamentScheduler?.getHealth() ?? null,
      tournamentCoordinator: tournamentCoordinator?.getHealth() ?? null,
      tournamentOperations: tournamentAdminStore.getHealthSnapshot(),
      roomShadowSync: roomShadowSynchronizer?.getHealth() ?? null,
      gameWorkerPool: poolHealth,
      trainingRecorder: {
        enabled: trainingRecorderMetrics.enabled,
        healthy: trainingRecorderMetrics.healthy,
        queuedRecords: trainingRecorderMetrics.queuedRecords,
        writtenRecords: trainingRecorderMetrics.writtenRecords,
        droppedRecords: trainingRecorderMetrics.droppedRecords,
        failedRecords: trainingRecorderMetrics.failedRecords,
        duplicateDeals: trainingRecorderMetrics.duplicateDeals,
        duplicateActions: trainingRecorderMetrics.duplicateActions,
        noActiveDeal: trainingRecorderMetrics.noActiveDeal,
        invalidTransition: trainingRecorderMetrics.invalidTransition,
        lastWriteAt: trainingRecorderMetrics.lastWriteAt,
        lastErrorAt: trainingRecorderMetrics.lastErrorAt,
      },
    })
    return
  }

  if (await handleSiteVisitPageViewRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleGuestContactRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handlePasswordResetRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAuthRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAccountRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (handleCheckNameRequest(req, res, requestUrl)) {
    return
  }

  if (await handleProfileRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminProfileModerationRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminSubadminRoleRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminChatAdminRoleRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminPikaTeamRoleRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminTopChatAdminRoleRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminVipGrantRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleFriendsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleChatRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleLobbyChatDeleteRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleProfileLikeRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleProfileBlockRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handlePlayersSearchRequest(req, res, requestUrl.pathname, requestUrl)) {
    return
  }

  if (await handlePlayersRequest(req, res, requestUrl.pathname, requestUrl)) {
    return
  }

  if (await handleLeaderboardsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handlePublicSettingsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleShopPackagesRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleLobbyPackagesRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminTournamentsRequest(req, res, requestUrl.pathname, requestUrl)) {
    return
  }

  if (await handleShopPurchasesRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleShopCheckoutRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleVipPurchasesRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleVipPackagesRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleVipCheckoutRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleVipStatusRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleVipClaimLaunchGiftRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTopicsListRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTopicSeenRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTopicThreadSeenRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTopicMessagesRequest(req, res, requestUrl.pathname, requestUrl)) {
    return
  }

  if (await handleTopicRepliesRequest(req, res, requestUrl.pathname, requestUrl)) {
    return
  }

  // handleTopicMuteEvidenceAttachmentDownloadRequest ПРЕДИ handleTopicAttachmentDownloadRequest
  // нарочно: и двата regex-а match-ват формата /api/topics/:x/attachments/:filename
  // (generic-ят третира ":x" като произволен topicId, включително литералния
  // сегмент "mute-evidence") — ако generic handler-ът е първи, moderator-only
  // evidence route-ът никога не се достига (dead code), а normal handler-ът
  // просто връща 404 (getAttachmentForDownload('mute-evidence', filename) не
  // намира нищо, защото 'mute-evidence' не е реална тема) вместо да enforce-не
  // moderator-only auth-а. По-специфичният route винаги първи.
  if (await handleTopicMuteEvidenceAttachmentDownloadRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTopicAttachmentDownloadRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTopicLockRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTopicUnlockRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTopicMuteStatusRequest(req, res, requestUrl.pathname, requestUrl)) {
    return
  }

  if (await handleTopicMuteRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTopicUnmuteRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTopicMuteEvidenceForSelfRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTopicMuteEvidenceForModeratorRequest(req, res, requestUrl.pathname, requestUrl)) {
    return
  }

  if (await handleTopicReportRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTopicReportsListRequest(req, res, requestUrl.pathname, requestUrl)) {
    return
  }

  if (await handleTopicReportReviewRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTopicModerationAuditLogRequest(req, res, requestUrl.pathname)) {
    return
  }

  // handleTopicMessageDeleteRequest ПРЕДИ handleTopicDeleteRequest —
  // по-специфичен path (4 сегмента, /messages/:messageId suffix).
  if (await handleTopicMessageEditRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTopicMessageDeleteRequest(req, res, requestUrl.pathname)) {
    return
  }

  // handleTopicDeleteRequest ПОСЛЕДЕН сред Topics route-овете — DELETE
  // /api/topics/:topicId regex-ът е широк (само 1 path segment) и би могъл
  // да засенчи по-специфични бъдещи routes, ако бъде поставен по-рано.
  if (await handleTopicDeleteRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleProfileByIdRequest(req, res, requestUrl.pathname)) {
    return
  }

  // handleTournamentBetaAccessRequest ПРЕДИ handleTournamentsListRequest —
  // /api/tournaments/beta-access не съвпада с handleTournamentsListRequest-
  // овия точен '/api/tournaments' pathname check, но explicit подредба тук
  // пази инварианта stable дори при бъдещ regex refactor надолу по веригата.
  if (await handleTournamentBetaAccessRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTournamentsListRequest(req, res, requestUrl.pathname, requestUrl)) {
    return
  }

  if (await handlePendingTournamentPartnerInvitesRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTournamentPartnerInviteNotificationRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTournamentPartnerCandidatesSearchRequest(req, res, requestUrl.pathname, requestUrl)) {
    return
  }

  if (await handleTournamentPartnerCandidatesRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTournamentPartnerInviteCreateRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTournamentPartnerInviteActionRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTournamentDetailRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTournamentJoinRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTournamentLeaveRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTournamentAcknowledgeBotReturnRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTournamentCancelRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleShopResumeCheckoutRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleShopHidePurchaseRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleStripeWebhookRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminSettingsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminCoinPackagesRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleMissionsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminMissionsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminStatsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminRegisteredProfilesListRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminPaymentDetailRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminPaymentsListRequest(req, res, requestUrl.pathname, requestUrl)) {
    return
  }

  if (await handleAdminVisitorSourcesRequest(req, res, requestUrl.pathname, requestUrl)) {
    return
  }

  if (await handleAdminVisitorsRequest(req, res, requestUrl.pathname, requestUrl)) {
    return
  }

  if (await handleAdminDailyRewardsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handlePublicRoomsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleGuestTrialStatusRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminMatchRoomsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (handleAdminMonitoringCurrentRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (handleAdminMonitoringHistoryRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (handleAdminMonitoringConnectionsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (handleAdminCpuIncidentsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (handleAdminCpuIncidentDetailRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminGuestContactMessagesRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleDailyRewardsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleSupportRequest(req, res, requestUrl.pathname)) {
    return
  }

  sendJsonResponse(res, 404, {
    ok: false,
    message: 'Not found',
  })
}

// Monitoring-only: закачи WS outbound брояча за единствения sendJsonMessage
// choke point (виж monitoring audit §4/§6) — bounded label по message.type.
setSendJsonMessageMonitoringHook((messageType) => {
  activityCounters.incrementWsOutbound(messageType)
})

setBroadcastRoomSnapshotsMonitoringHook(() => {
  activityCounters.incrementGame('roomSnapshotBroadcasts')
})

const httpServer = createServer((req, res) => {
  void handleHttpRequest(req, res).catch((error) => {
    const message = error instanceof Error ? error.message : 'Unexpected server error.'

    if (!res.headersSent) {
      sendJsonResponse(res, 500, {
        ok: false,
        message,
      })
      return
    }

    res.end()
  })
})

const wsServer = new WebSocketServer({
  server: httpServer,
  path: '/ws',
})

wsServer.on('connection', (socket, request) => {
  if (isServerShuttingDown) {
    socket.close()
    return
  }

  const authSession = authStore.getSession(
    getSessionTokenFromCookieHeader(request.headers.cookie),
  )
  const connection = createServerConnection({
    remoteAddress: request.socket.remoteAddress ?? null,
    userAgent:
      typeof request.headers['user-agent'] === 'string'
        ? request.headers['user-agent']
        : null,
    playerId: authSession?.profile.profileId ?? null,
    profileId: authSession?.profile.profileId ?? null,
  })

  serverState = upsertServerConnection(serverState, connection)
  socketRegistry.set(connection.id, socket)

  if (authSession === null) {
    const guestId = getGuestIdFromCookieHeader(request.headers.cookie)
    if (guestId !== null) {
      guestIdByConnection.set(connection.id, guestId)
    }
  }

  console.log(
    `[ws] client connected: ${connection.id} (${connection.remoteAddress ?? 'unknown'}) profile=${connection.profileId ?? 'none'}`,
  )

  sendJsonMessage(socket, {
    type: 'connected',
    clientId: connection.id,
    message: 'Connected to Belot V2 server.',
  })

  if (connection.profileId !== null) {
    if (!sendSessionInGameIfNeeded(connection.id, connection.profileId)) {
      displaceProfileConnections(connection.profileId, connection.id)
    }

    const pendingFriendships = friendshipStore.listForProfile(connection.profileId)
    if (pendingFriendships.incomingPending.length > 0) {
      sendJsonMessage(socket, {
        type: 'pending_friend_requests',
        requests: pendingFriendships.incomingPending.map((r) => ({
          friendshipId: r.friendshipId,
          fromProfileId: r.profile.profileId ?? '',
          fromDisplayName: r.profile.displayName,
          fromAvatarUrl: r.profile.avatarUrl,
        })),
      })
    }

    const unreadAcceptances = friendshipStore.getUnreadAcceptances(connection.profileId)
    if (unreadAcceptances.length > 0) {
      sendJsonMessage(socket, {
        type: 'pending_acceptance_notifications',
        notifications: unreadAcceptances.map((n) => ({
          friendshipId: n.friendshipId,
          fromProfileId: n.friendProfile.profileId ?? '',
          fromDisplayName: n.friendProfile.displayName,
          fromAvatarUrl: n.friendProfile.avatarUrl,
        })),
      })
    }

    const pendingGifts = yellowCoinGiftStore.getPendingGiftNotifications(connection.profileId)
    if (pendingGifts.length > 0) {
      sendJsonMessage(socket, {
        type: 'pending_gift_notifications',
        gifts: pendingGifts,
      })
    }

    // Durable "партньорът ти се отписа" flush (§ "PARTNER-LEFT NOTIFICATION
    // ТРЯБВА Е DURABLE") — огледално на pendingGifts по-горе: ако recipient-ът
    // е бил offline в момента на committed auto-release, известието чака тук
    // с delivered_at=NULL до точно този login/reconnect. Маркираме delivered
    // веднага след push-а, за да не се доставя повторно при следващ
    // login/multi-tab reconnect (същия idempotency контракт като gift log-а).
    const pendingPartnerLeftNotices = tournamentEconomyStore.getPendingPartnerLeftNotices(connection.profileId)
    for (const notice of pendingPartnerLeftNotices) {
      sendJsonMessage(socket, {
        type: 'tournament_economy_notice',
        eventId: randomUUID(),
        tournamentId: notice.tournamentId,
        reason: 'partner_left',
        amount: notice.refundedAmount,
        occurredAt: new Date().toISOString(),
      })
      tournamentEconomyStore.markPartnerLeftNoticeDelivered(notice.noticeId, connection.profileId)
    }

    // Durable auto-cancel refund flush (§"OFFLINE USER"/"EXACTLY ONCE" в
    // допълнението за "Турнирът е анулиран..." известието) — огледално на
    // pendingPartnerLeftNotices по-горе: ако recipient-ът е бил offline в
    // момента на committed fill-timeout/scheduled-underfilled auto-cancel,
    // известието чака тук до точно този login/reconnect. Маркираме delivered
    // веднага след push-а — same idempotency контракт.
    const pendingTournamentEconomyNotices = tournamentEconomyStore.getPendingTournamentEconomyNotices(connection.profileId)
    for (const notice of pendingTournamentEconomyNotices) {
      sendJsonMessage(socket, {
        type: 'tournament_economy_notice',
        eventId: randomUUID(),
        tournamentId: notice.tournamentId,
        reason: notice.reason,
        amount: notice.refundedAmount,
        occurredAt: new Date().toISOString(),
      })
      tournamentEconomyStore.markTournamentEconomyNoticeDelivered(notice.noticeId, connection.profileId)
    }

    const undismissedPartnerInvites = tournamentEconomyStore
      .listUndismissedPendingPartnerInvitesForProfile(connection.profileId)
    for (const invite of undismissedPartnerInvites) {
      sendJsonMessage(socket, {
        type: 'tournament_partner_invite_received',
        invite: buildTournamentPartnerInviteDto(invite),
      })
    }

    const tournamentAssignment = tournamentCoordinator?.getAssignmentForProfile(connection.profileId)
    if (tournamentAssignment !== undefined && tournamentAssignment !== null) {
      sendJsonMessage(socket, {
        type: 'tournament_match_assigned',
        assignment: tournamentAssignment,
      })
    } else {
      // Login/reconnect докато профилът е между кръгове (STATE A/B —
      // §"НЕ ВРЪЗВАЙ BLOCKING MODAL САМО С ACTIVE ROOM" в допълнението):
      // tournament_match_assigned по-горе покрива само gameplay/attendance/
      // countdown (реален runnable match). Тук покриваме случая, когато
      // профилът все още е 'confirmed'/'finalist' в активен турнир, но
      // няма runnable match в момента (sibling още играе, ИЛИ next round
      // room вече е готов) — клиентът получава само tournamentId и сам
      // resolve-ва точния destination (STATE A/STATE B) чрез
      // authoritative GET /api/tournaments/:id (myInterRoundWaiting).
      const activeTournamentId = tournamentCoordinator?.getActiveTournamentIdForProfile(connection.profileId)
      if (activeTournamentId !== undefined && activeTournamentId !== null) {
        sendJsonMessage(socket, {
          type: 'tournament_active_participation',
          tournamentId: activeTournamentId,
        })
      }
    }
  }

  socket.on('message', (raw: RawData) => {
    try {
      const currentConnection = getConnectionById(serverState, connection.id)

      if (currentConnection !== null) {
        const heartbeatConnection = updateConnectionHeartbeat(
          currentConnection,
          connection.id,
        )

        serverState = updateServerConnectionInState(
          serverState,
          connection.id,
          heartbeatConnection,
        )
      }

      const rawText = rawDataToText(raw)
      const message = parseClientMessage(rawText)

      if (message === null) {
        sendJsonMessage(socket, {
          type: 'error',
          message: 'Invalid message payload.',
        })
        return
      }

      activityCounters.incrementWsInbound(message.type)

      if (isServerShuttingDown && isShutdownGuardedClientMessage(message)) {
        // submit_bid_action е fire-and-forget за клиента (виж
        // markBiddingPopupPending() в createActiveRoomFlowController.ts) —
        // без explicit отговор играчът остава заклещен в pending/faded
        // popup до самостоятелен client-side watchdog/resync. Останалите
        // shutdown-guarded типове запазват съществуващото поведение
        // (мълчаливо dropped по време на graceful shutdown) — не разширяваме
        // fix-а извън submit_bid_action, за да не пипаме несвързани action
        // recovery paths без анализ.
        if (message.type === 'submit_bid_action') {
          sendJsonMessage(socket, {
            type: 'error',
            message: 'Сървърът рестартира. Моля опитайте отново.',
          })
        }
        return
      }

      if (message.type === 'ping') {
        sendJsonMessage(socket, {
          type: 'pong',
          timestamp: Date.now(),
        })
        return
      }

      if (message.type === 'request_player_profile') {
        sendPlayerProfileToConnection(connection.id, message.roomId, message.seat)
        return
      }

      if (message.type === 'submit_bid_action') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Connection was not found.',
          })
          return
        }

        if (latestConnection.status !== 'connected') {
          logRejectedGameplayAction({
            actionType: 'submit_bid_action',
            roomId: message.roomId,
            seat: latestConnection.currentSeat,
            connectionId: connection.id,
            connectionStatus: latestConnection.status,
            reason: 'stale_connection',
          })
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Връзката не е активна.',
          })
          return
        }

        if (latestConnection.currentRoomId !== message.roomId) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'You are not attached to this room.',
          })
          return
        }

        if (!latestConnection.currentSeat) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Your seat was not found.',
          })
          return
        }

        const room = serverState.rooms[message.roomId] ?? null

        if (room === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Room was not found.',
          })
          return
        }

        const result = activeRoomRuntime.submitBid({
          room,
          seat: latestConnection.currentSeat,
          action: message.action,
        })

        if (!result.ok) {
          logRejectedGameplayAction({
            actionType: 'submit_bid_action',
            roomId: message.roomId,
            seat: latestConnection.currentSeat,
            connectionId: connection.id,
            connectionStatus: latestConnection.status,
            reason: result.message,
          })
          safeSendToConnection(connection.id, {
            type: 'error',
            message: result.message,
          })
          return
        }

        activityCounters.incrementGame('gameplayBidAccepted')
        handleTrainingRecorderHumanBid(trainingRecorder, room, result.room)
        serverState = commitServerRoomWithSnapshot(result.room)
        activeRoomRuntime.ensureRoom(result.room)
        broadcastRoomSnapshots(result.room, socketRegistry)
        return
      }

      if (message.type === 'submit_cut_index') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Connection was not found.',
          })
          return
        }

        if (latestConnection.status !== 'connected') {
          logRejectedGameplayAction({
            actionType: 'submit_cut_index',
            roomId: message.roomId,
            seat: latestConnection.currentSeat,
            connectionId: connection.id,
            connectionStatus: latestConnection.status,
            reason: 'stale_connection',
          })
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Връзката не е активна.',
          })
          return
        }

        if (latestConnection.currentRoomId !== message.roomId) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'You are not attached to this room.',
          })
          return
        }

        if (!latestConnection.currentSeat) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Your seat was not found.',
          })
          return
        }

        const room = serverState.rooms[message.roomId] ?? null

        if (room === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Room was not found.',
          })
          return
        }

        const result = activeRoomRuntime.submitCut({
          room,
          seat: latestConnection.currentSeat,
          cutIndex: message.cutIndex,
        })

        if (!result.ok) {
          logRejectedGameplayAction({
            actionType: 'submit_cut_index',
            roomId: message.roomId,
            seat: latestConnection.currentSeat,
            connectionId: connection.id,
            connectionStatus: latestConnection.status,
            reason: result.message,
          })
          safeSendToConnection(connection.id, {
            type: 'error',
            message: result.message,
          })
          return
        }

        activityCounters.incrementGame('gameplayCutAccepted')
        serverState = commitServerRoomWithSnapshot(result.room)
        activeRoomRuntime.ensureRoom(result.room)
        broadcastRoomSnapshots(result.room, socketRegistry)
        return
      }

      if (message.type === 'submit_play_card') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Connection was not found.',
          })
          return
        }

        // A connection that has been displaced (multi-tab/multi-device
        // resume_room on the same profile) or has already disconnected keeps
        // its currentRoomId/currentSeat populated — only leave_active_room
        // clears those. Without this check a stale connection object could
        // still authorize a play for a seat that another, now-live
        // connection owns. See checkGameplayActionStaleConnectionGuard.ts.
        if (latestConnection.status !== 'connected') {
          logRejectedGameplayAction({
            actionType: 'submit_play_card',
            roomId: message.roomId,
            seat: latestConnection.currentSeat,
            cardId: message.cardId,
            connectionId: connection.id,
            connectionStatus: latestConnection.status,
            reason: 'stale_connection',
          })
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Връзката не е активна.',
          })
          return
        }

        if (latestConnection.currentRoomId !== message.roomId) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'You are not attached to this room.',
          })
          return
        }

        if (!latestConnection.currentSeat) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Your seat was not found.',
          })
          return
        }

        const room = serverState.rooms[message.roomId] ?? null

        if (room === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Room was not found.',
          })
          return
        }

        const result = activeRoomRuntime.submitPlay({
          room,
          seat: latestConnection.currentSeat,
          cardId: message.cardId,
          declarationKeys: message.declarationKeys,
        })

        if (!result.ok) {
          logRejectedGameplayAction({
            actionType: 'submit_play_card',
            roomId: message.roomId,
            seat: latestConnection.currentSeat,
            cardId: message.cardId,
            connectionId: connection.id,
            connectionStatus: latestConnection.status,
            reason: result.message,
          })
          safeSendToConnection(connection.id, {
            type: 'error',
            message: result.message,
          })
          return
        }

        activityCounters.incrementGame('gameplayPlayAccepted')
        logAcceptedCardPlayAudit({
          previousRoom: room,
          nextRoom: result.room,
          isHumanManualSubmission: true,
          connectionId: connection.id,
        })
        handleTrainingRecorderHumanCard(trainingRecorder, room, result.room)
        serverState = commitServerRoomWithSnapshot(result.room)
        activeRoomRuntime.ensureRoom(result.room)
        broadcastRoomSnapshots(result.room, socketRegistry)
        // Direct human submit_play_card commit минава покрай
        // applyAcceptedGameWorkerCandidate/onApplied (виж коментара при
        // shouldRunMatchCompletionSideEffects) — затова "Играещи" score push
        // и match-ended detection трябва да се закачат и тук отделно, за да
        // не пропуснем случая, при който ИМЕННО тази ръчна карта е последната
        // на мача (worker-tick следващия път вече ще вижда и previousRoom, и
        // nextRoom като match-ended, значи idempotency guard-ът никога не би
        // хванал прехода само от worker-tick страна).
        if (shouldRunMatchCompletionSideEffects(room, result.room)) {
          recordPrivateGameFinishedIfApplicable(result.room)
        } else {
          notifyPrivateGameScoreProgress(result.room)
        }
        return
      }

      if (message.type === 'resume_human_control') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Connection was not found.',
          })
          return
        }

        if (latestConnection.currentRoomId !== message.roomId) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'You are not attached to this room.',
          })
          return
        }

        if (!latestConnection.currentSeat) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Your seat was not found.',
          })
          return
        }

        const room = serverState.rooms[message.roomId] ?? null

        if (room === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Room was not found.',
          })
          return
        }

        const result = activeRoomRuntime.resumeHumanControl({
          room,
          seat: latestConnection.currentSeat,
        })

        if (!result.ok) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: result.message,
          })
          return
        }

        serverState = commitServerRoomWithSnapshot(result.room)
        activeRoomRuntime.ensureRoom(result.room)
        broadcastRoomSnapshots(result.room, socketRegistry)
        return
      }

      if (message.type === 'submit_partner_rating') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Connection was not found.',
          })
          return
        }

        if (latestConnection.currentRoomId !== message.roomId) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'You are not attached to this room.',
          })
          return
        }

        if (!latestConnection.currentSeat) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Your seat was not found.',
          })
          return
        }

        const room = serverState.rooms[message.roomId] ?? null

        if (room === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Room was not found.',
          })
          return
        }

        const result = playerProgressStore.submitPartnerRating(
          room,
          latestConnection.currentSeat,
          message.ratingValue,
        )

        if (!result.ok) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: result.message,
          })
          return
        }

        const raterSeat = latestConnection.currentSeat
        const partnerSeat = getPartnerSeat(raterSeat)
        const raterParticipant = room.seats[raterSeat]?.participant ?? null
        const partnerParticipant = room.seats[partnerSeat]?.participant ?? null
        const partnerProfileId =
          partnerParticipant?.identity.profileId ?? partnerParticipant?.publicProfile?.profileId ?? null

        if (partnerProfileId !== null) {
          sendToOpenProfileConnections(partnerProfileId, {
            type: 'partner_rating_submitted',
            roomId: message.roomId,
            ratingValue: message.ratingValue,
            raterDisplayName:
              raterParticipant?.identity.displayName?.trim() || 'Партньорът ти',
          })
        }
        return
      }

      if (message.type === 'request_replay') {
        const replayConnection = getConnectionById(serverState, connection.id)
        const replaySeat = replayConnection?.currentSeat ?? null
        const replayRoom = replayConnection?.currentRoomId
          ? (serverState.rooms[replayConnection.currentRoomId] ?? null)
          : null

        if (!replayRoom || replaySeat === null || replayConnection?.currentRoomId !== message.roomId) {
          return
        }

        if (isTournamentMatchRoom(replayRoom)) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Турнирните мачове не поддържат преиграване.',
          })
          return
        }

        if (replayRoom.config.isGuestTrial) {
          safeSendToConnection(connection.id, {
            type: 'guest_trial_error',
            message: 'Пробните игри не поддържат преиграване. Стартирайте нова пробна игра от лобито.',
            reason: 'guest_trial_unavailable',
            remaining: 0,
          })
          return
        }

        const authState = replayRoom.game.authoritativeState
        if (!authState || 'kind' in authState || authState.phase !== 'match-ended') {
          return
        }

        const currentVotes = replayRoom.replayVotes ?? []
        if (currentVotes.includes(replaySeat)) {
          return
        }

        const updatedVotes = [...currentVotes, replaySeat]

        const occupiedSeats = SERVER_SEAT_ORDER.filter((s) => replayRoom.seats[s].participant !== null)
        const allVoted = occupiedSeats.every((s) => updatedVotes.includes(s))

        function applyReplayRestart(room: ServerRoom): void {
          const now = Date.now()
          const resetRoom: ServerRoom = {
            ...room,
            replayVotes: [],
            leaveVotes: [],
            updatedAt: now,
            game: {
              ...room.game,
              phase: null,
              stateVersion: room.game.stateVersion + 1,
              startedAt: null,
              updatedAt: now,
              activeTimerId: null,
              timerDeadlineAt: null,
              authoritativeState: null,
            },
          }
          const restartedRoom = initializeRoomAuthoritativeGameState(resetRoom)
          const stakeAmount = restartedRoom.config.stakeAmount ?? 0
          if (stakeAmount > 0) {
            const stakeResult = matchEconomyStore.collectRoomStakes(restartedRoom, stakeAmount)
            if (!stakeResult.ok) {
              console.error(`[match-economy] replay stake collection failed room=${restartedRoom.id}: ${stakeResult.message}`)
            }
            const botReplayStakeResult = matchEconomyStore.collectBotStakes(restartedRoom, stakeAmount)
            if (!botReplayStakeResult.ok) {
              console.error(`[match-economy] replay bot stake collection failed room=${restartedRoom.id}: ${botReplayStakeResult.message}`)
            }
          }
          serverState = commitServerRoomWithSnapshot(restartedRoom)
          activeRoomRuntime.ensureRoom(restartedRoom)
          broadcastRoomSnapshots(restartedRoom, socketRegistry)
        }

        if (allVoted) {
          applyReplayRestart(replayRoom)
        } else {
          const votedRoom: ServerRoom = { ...replayRoom, replayVotes: updatedVotes }
          serverState = commitServerRoomReplacement(votedRoom)
          broadcastRoomSnapshots(votedRoom, socketRegistry)

          // Ако това е първото гласуване от човек — ботовете гласуват автоматично по 1 сек.
          const wasFirstHumanVote = !currentVotes.some(
            (s) => replayRoom.seats[s].participant?.kind === 'human',
          )
          if (wasFirstHumanVote) {
            const botSeats = SERVER_SEAT_ORDER.filter(
              (s) => replayRoom.seats[s].participant?.kind === 'bot',
            )
            botSeats.forEach((botSeat, index) => {
              setTimeout(() => {
                if (isServerShuttingDown) return

                const latestRoom = serverState.rooms[message.roomId] ?? null
                if (!latestRoom) return
                const latestAuth = latestRoom.game.authoritativeState
                if (!latestAuth || 'kind' in latestAuth || latestAuth.phase !== 'match-ended') return
                if (latestRoom.replayVotes.includes(botSeat)) return
                if (latestRoom.leaveVotes?.includes(botSeat)) return

                const botParticipant = latestRoom.seats[botSeat].participant
                const botProfileId = botParticipant?.kind === 'bot' ? (botParticipant.botProfileId ?? null) : null
                const stake = latestRoom.config.stakeAmount ?? 0
                const canAffordReplay = botProfileId !== null && stake > 0
                  ? matchEconomyStore.hasEnoughBalance(botProfileId, stake)
                  : true

                if (!canAffordReplay) {
                  const botLeaveRoom: ServerRoom = {
                    ...latestRoom,
                    leaveVotes: [...(latestRoom.leaveVotes ?? []), botSeat],
                  }
                  serverState = commitServerRoomReplacement(botLeaveRoom)
                  broadcastRoomSnapshots(botLeaveRoom, socketRegistry)
                  return
                }

                const botVotes = [...latestRoom.replayVotes, botSeat]
                const allSeats = SERVER_SEAT_ORDER.filter((s) => latestRoom.seats[s].participant !== null)
                if (allSeats.every((s) => botVotes.includes(s))) {
                  applyReplayRestart(latestRoom)
                } else {
                  const botVotedRoom: ServerRoom = { ...latestRoom, replayVotes: botVotes }
                  serverState = commitServerRoomReplacement(botVotedRoom)
                  broadcastRoomSnapshots(botVotedRoom, socketRegistry)
                }
              }, (index + 1) * 1000)
            })
          }
        }
        return
      }

      if (message.type === 'request_leave_match') {
        const leaveConn = getConnectionById(serverState, connection.id)
        const leaveSeat = leaveConn?.currentSeat ?? null
        const leaveRoom = leaveConn?.currentRoomId
          ? (serverState.rooms[leaveConn.currentRoomId] ?? null)
          : null

        if (leaveRoom && leaveSeat !== null && leaveConn?.currentRoomId === message.roomId) {
          const leaveAuth = leaveRoom.game.authoritativeState
          if (leaveAuth && !('kind' in leaveAuth) && leaveAuth.phase === 'match-ended') {
            const currentLeaveVotes = leaveRoom.leaveVotes ?? []
            if (!currentLeaveVotes.includes(leaveSeat)) {
              const updatedLeaveRoom: ServerRoom = {
                ...leaveRoom,
                leaveVotes: [...currentLeaveVotes, leaveSeat],
              }
              serverState = commitServerRoomReplacement(updatedLeaveRoom)
              broadcastRoomSnapshots(updatedLeaveRoom, socketRegistry)
            }
          }
        }
        return
      }

      if (message.type === 'send_emoji_reaction') {
        const emojiConn = getConnectionById(serverState, connection.id)
        const emojiSeat = emojiConn?.currentSeat ?? null
        const emojiRoom = emojiConn?.currentRoomId === message.roomId
          ? (serverState.rooms[message.roomId] ?? null)
          : null

        if (emojiRoom !== null && emojiSeat !== null) {
          const emojiMsg = {
            type: 'emoji_reaction' as const,
            roomId: message.roomId,
            seat: emojiSeat,
            emojiId: message.emojiId,
          }
          for (const s of SERVER_SEAT_ORDER) {
            const participant = emojiRoom.seats[s].participant
            if (participant === null || participant.kind !== 'human' || !participant.isConnected || participant.connectionId === null) {
              continue
            }
            const sock = socketRegistry.get(participant.connectionId)
            if (sock && sock.readyState === WebSocket.OPEN) {
              sendJsonMessage(sock, emojiMsg)
            }
          }
        }
        return
      }

      if (message.type === 'send_phrase_reaction') {
        const phraseConn = getConnectionById(serverState, connection.id)
        const phraseSeat = phraseConn?.currentSeat ?? null
        const phraseRoom = phraseConn?.currentRoomId === message.roomId
          ? (serverState.rooms[message.roomId] ?? null)
          : null

        if (phraseRoom !== null && phraseSeat !== null) {
          const phraseMsg = {
            type: 'phrase_reaction' as const,
            roomId: message.roomId,
            seat: phraseSeat,
            phraseId: message.phraseId,
          }
          for (const s of SERVER_SEAT_ORDER) {
            const participant = phraseRoom.seats[s].participant
            if (participant === null || participant.kind !== 'human' || !participant.isConnected || participant.connectionId === null) {
              continue
            }
            const sock = socketRegistry.get(participant.connectionId)
            if (sock && sock.readyState === WebSocket.OPEN) {
              sendJsonMessage(sock, phraseMsg)
            }
          }
        }
        return
      }

      if (message.type === 'resume_room') {
        if (connection.profileId !== null) {
          displaceProfileConnections(connection.profileId, connection.id)
        }

        const result = tryResumeRoomForConnection(
          connection.id,
          message.roomId,
          message.reconnectToken,
        )

        if (!result.ok) {
          safeSendToConnection(connection.id, {
            type: 'room_resume_failed',
            roomId: message.roomId,
            message: result.message,
          })
          return
        }

        // Seat attachment above is IDENTICAL for silent and normal resume —
        // tryResumeRoomForConnection/attachConnectionToRoomSeat ran exactly
        // the same way regardless of message.silent. Only the response type
        // differs, so the client can tell whether it's expected to navigate
        // to the active-room screen. broadcastRoomSnapshots still fires
        // either way — other seated participants (and any bot-replacement
        // UI) need the fresh snapshot regardless of whether THIS connection
        // navigates visually.
        safeSendToConnection(connection.id, message.silent === true
          ? {
              type: 'room_attached_silent',
              roomId: result.room.id,
              seat: result.seat,
              profileId: connection.profileId,
            }
          : {
              type: 'room_resumed',
              roomId: result.room.id,
              seat: result.seat,
            })

        broadcastRoomSnapshots(result.room, socketRegistry)
        return
      }

      if (message.type === 'tournament_semifinal_result_acknowledge') {
        if (connection.profileId === null || tournamentCoordinator === null) {
          return
        }
        if (!hasTournamentBetaAccessForProfile(connection.profileId)) {
          return
        }
        const result = tournamentCoordinator.acknowledgeSemifinalResult({
          tournamentId: message.tournamentId,
          semifinalMatchId: message.semifinalMatchId,
          profileId: connection.profileId,
        })
        if (result.ok) {
          tournamentCoordinator.tickNow()
        }
        return
      }

      if (message.type === 'join_matchmaking') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection === null) {
          throw new Error(`Connection "${connection.id}" was not found.`)
        }

        if (latestConnection.currentRoomId !== null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Вече си в активна игра.',
          })
          return
        }

        if (latestConnection.profileId === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Трябва да влезеш в профила си, за да играеш на маса.',
          })
          return
        }

        const publicProfile = playerProgressStore.getPublicProfile(
          latestConnection.profileId,
        )

        if (publicProfile === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Профилът не беше намерен. Влез отново.',
          })
          return
        }

        const profileId = publicProfile.profileId ?? latestConnection.profileId
        if (sendSessionInGameIfNeeded(connection.id, profileId)) {
          return
        }

        const stablePlayerConnection = {
          ...latestConnection,
          playerId: latestConnection.playerId ?? profileId,
        }

        const room = matchRoomsStore.getRoom(message.stake)
        if (!room || !room.isEnabled) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Тази стая не е достъпна.',
          })
          return
        }

        if ((publicProfile.level ?? 1) < room.minLevel) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: `Тази стая изисква минимално ниво ${room.minLevel}. Твоето ниво е ${publicProfile.level ?? 1}.`,
          })
          return
        }

        if (!matchEconomyStore.hasEnoughBalance(profileId, message.stake)) {
          const existingEntry = getQueueEntryByConnectionId(
            matchmakingState.queueEntries,
            connection.id,
          )

          if (existingEntry !== null) {
            removeConnectionFromMatchmaking(connection.id)
          }

          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Нямаш достатъчно жълтици за този залог.',
          })
          return
        }

        serverState = updateServerConnectionInState(
          serverState,
          connection.id,
          stablePlayerConnection,
        )

        const existingEntry = getQueueEntryByConnectionId(
          matchmakingState.queueEntries,
          connection.id,
        )

        if (existingEntry !== null && existingEntry.stake === message.stake) {
          collectReadyMatchmakingStakes(existingEntry.stake)
          const searchingEntries = getSearchingEntriesByStake(
            matchmakingState.queueEntries,
            existingEntry.stake,
          ).sort((a, b) => a.joinedAt - b.joinedAt)
          const previewBotDisplayNames = selectMatchmakingBotProfiles({
            stake: existingEntry.stake,
            count: Math.max(0, MATCH_PLAYERS_REQUIRED - searchingEntries.length),
            selectionSeed: createMatchmakingBotSelectionSeed(
              existingEntry.stake,
              searchingEntries,
            ),
            minLevel: matchRoomsStore.getRoom(existingEntry.stake)?.minLevel ?? 1,
          }).map((profile) => profile.identity.displayName)

          safeSendToConnection(connection.id, {
            type: 'matchmaking_joined',
            stake: existingEntry.stake,
            queuedPlayers: searchingEntries.length,
            requiredPlayers: MATCH_PLAYERS_REQUIRED,
            countdownEndsAt: existingEntry.expiresAt,
            remainingMs: Math.max(0, existingEntry.expiresAt - Date.now()),
            previewBotDisplayNames,
            queuedPlayerPreviews: createQueuedPlayerPreviews(searchingEntries, connection.id),
          })

          sendMatchmakingStatusToConnection(connection.id, existingEntry.stake)
          return
        }

        if (existingEntry !== null) {
          removeConnectionFromMatchmaking(connection.id)
        }

        const stakeMinLevelForEntry = matchRoomsStore.getRoom(message.stake)?.minLevel ?? 1
        const nextEntry = createMatchmakingQueueEntry({
          connectionId: connection.id,
          playerId: stablePlayerConnection.playerId ?? stablePlayerConnection.id,
          profileId,
          publicProfile,
          displayName: publicProfile.displayName,
          stake: message.stake,
          waitMs: stakeMinLevelForEntry > 7 ? 60000 : 20000,
        })

        matchmakingState = {
          ...matchmakingState,
          queueEntries: addQueueEntry(matchmakingState.queueEntries, nextEntry),
        }

        activityCounters.incrementRooms('matchmakingJoin')
        collectReadyMatchmakingStakes(nextEntry.stake)

        const queuedEntryAfterStakeCollection = getQueueEntryByConnectionId(
          matchmakingState.queueEntries,
          connection.id,
        )

        if (queuedEntryAfterStakeCollection === null) {
          return
        }

        const searchingEntries = getSearchingEntriesByStake(
          matchmakingState.queueEntries,
          queuedEntryAfterStakeCollection.stake,
        ).sort((a, b) => a.joinedAt - b.joinedAt)
        const joinedStakeMinLevel = matchRoomsStore.getRoom(queuedEntryAfterStakeCollection.stake)?.minLevel ?? 1
        const previewBotDisplayNames = joinedStakeMinLevel > 7
          ? []
          : selectMatchmakingBotProfiles({
              stake: queuedEntryAfterStakeCollection.stake,
              count: Math.max(0, MATCH_PLAYERS_REQUIRED - searchingEntries.length),
              selectionSeed: createMatchmakingBotSelectionSeed(
                queuedEntryAfterStakeCollection.stake,
                searchingEntries,
              ),
              minLevel: joinedStakeMinLevel,
            }).map((profile) => profile.identity.displayName)

        safeSendToConnection(connection.id, {
          type: 'matchmaking_joined',
          stake: queuedEntryAfterStakeCollection.stake,
          queuedPlayers: searchingEntries.length,
          requiredPlayers: MATCH_PLAYERS_REQUIRED,
          countdownEndsAt: queuedEntryAfterStakeCollection.expiresAt,
          remainingMs: Math.max(0, queuedEntryAfterStakeCollection.expiresAt - Date.now()),
          totalDurationMs: queuedEntryAfterStakeCollection.expiresAt - queuedEntryAfterStakeCollection.joinedAt,
          previewBotDisplayNames,
          queuedPlayerPreviews: createQueuedPlayerPreviews(searchingEntries, connection.id),
        })

        broadcastMatchmakingStatusForStake(queuedEntryAfterStakeCollection.stake)
        processMatchmaking()
        return
      }

      if (message.type === 'join_guest_trial') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection === null) {
          throw new Error(`Connection "${connection.id}" was not found.`)
        }

        if (latestConnection.profileId !== null) {
          safeSendToConnection(connection.id, {
            type: 'guest_trial_error',
            message: 'Влезли сте в профил — пробните игри са само за гости.',
            reason: 'guest_trial_unavailable',
            remaining: 0,
          })
          return
        }

        if (latestConnection.currentRoomId !== null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Вече си в активна игра.',
          })
          return
        }

        if (message.stake !== GUEST_TRIAL_STAKE) {
          safeSendToConnection(connection.id, {
            type: 'guest_trial_error',
            message: 'Пробните игри са достъпни само на маса с вход 5 000.',
            reason: 'guest_trial_invalid_stake',
            remaining: 0,
          })
          return
        }

        const guestId = guestIdByConnection.get(connection.id)

        if (guestId === undefined) {
          safeSendToConnection(connection.id, {
            type: 'guest_trial_error',
            message: 'Гостовата сесия не беше намерена. Презареди страницата.',
            reason: 'guest_trial_unavailable',
            remaining: 0,
          })
          return
        }

        const trialResult = guestTrialStore.registerTrialGameStarted(guestId)

        if (!trialResult.ok) {
          safeSendToConnection(connection.id, {
            type: 'guest_trial_error',
            message: trialResult.message,
            reason: trialResult.reason,
            remaining: 0,
          })
          return
        }

        let guestRoomResult: ReturnType<typeof createGuestTrialRoom>

        try {
          guestRoomResult = createGuestTrialRoom({
            connectionId: connection.id,
            guestId,
            stake: message.stake,
          })
        } catch (error) {
          console.error('[guest-trial] failed to create trial room:', error)
          guestTrialStore.undoTrialGameStarted(guestId)
          safeSendToConnection(connection.id, {
            type: 'guest_trial_error',
            message: 'Не може да се стартира пробна игра в момента.',
            reason: 'guest_trial_unavailable',
            remaining: trialResult.session.remaining + 1,
          })
          return
        }

        const initializedGuestRoom = initializeRoomAuthoritativeGameState(guestRoomResult.room)

        const ensureGuestRoomResult = activeRoomRuntime.ensureRoom(initializedGuestRoom)

        if (!ensureGuestRoomResult.ok) {
          console.error(
            `[guest-trial] no runtime capacity for room=${initializedGuestRoom.id}: ${ensureGuestRoomResult.reason}`,
          )
          guestTrialStore.undoTrialGameStarted(guestId)
          safeSendToConnection(connection.id, {
            type: 'guest_trial_error',
            message: 'Не може да се стартира пробна игра в момента.',
            reason: 'guest_trial_unavailable',
            remaining: trialResult.session.remaining + 1,
          })
          return
        }

        guestTrialStore.recordTrialGameStart(guestId, initializedGuestRoom.id, message.stake)

        const attachedGuestConnection = attachConnectionToRoomSeat(
          latestConnection,
          connection.id,
          initializedGuestRoom,
          guestRoomResult.hostSeat,
        )

        serverState = updateServerConnectionInState(
          serverState,
          connection.id,
          attachedGuestConnection,
        )

        serverState = commitServerRoomWithSnapshot(initializedGuestRoom, serverState)

        safeSendToConnection(connection.id, {
          type: 'match_found',
          roomId: initializedGuestRoom.id,
          seat: guestRoomResult.hostSeat,
          stake: message.stake,
          humanPlayers: 1,
          botPlayers: 3,
          shouldStartImmediately: true,
        })

        broadcastRoomSnapshots(initializedGuestRoom, socketRegistry)

        console.log(
          `[guest-trial] room created ${initializedGuestRoom.id} | guest=${guestId} | remaining=${trialResult.session.remaining}`,
        )

        return
      }

      if (message.type === 'leave_matchmaking') {
        const removed = removeConnectionFromMatchmaking(connection.id)

        safeSendToConnection(connection.id, {
          type: 'matchmaking_left',
          removed,
        })

        return
      }

      if (message.type === 'leave_active_room') {
        removeConnectionFromMatchmaking(connection.id)

        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Connection was not found.',
          })
          return
        }

        if (latestConnection.currentRoomId !== message.roomId) {
          // Идемпотентност: ако connection-ът вече изобщо не е закачен за
          // никоя стая, или конкретно тази стая вече не съществува (напр.
          // турнирна стая, force-затворена от tournamentCoordinator веднага
          // след завършек на мача — виж closeCompletedTournamentRoom — ПРЕДИ
          // клиентският "Към лобито" leave_active_room да пристигне),
          // намерението на извикващия ("не искам да съм в тази стая") вече
          // е изпълнено. Връщаме benign left_active_room вместо подвеждащ
          // "You are not attached to this room." toast — клиентът вече е
          // напуснал/показал лобито fire-and-forget. Ако connection-ът реално
          // е закачен за ДРУГА валидна стая, това си остава грешка.
          if (latestConnection.currentRoomId === null || serverState.rooms[message.roomId] === undefined) {
            safeSendToConnection(connection.id, {
              type: 'left_active_room',
              roomId: message.roomId,
              removed: false,
            })
            return
          }
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'You are not attached to this room.',
          })
          return
        }

        const room = serverState.rooms[message.roomId] ?? null

        if (room === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Room was not found.',
          })
          return
        }

        const participant = findHumanParticipantByConnectionId(room, connection.id)

        if (participant === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Your player was not found in this room.',
          })
          return
        }

        const seat = findParticipantSeat(room, participant.playerId)

        if (seat === null) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Your seat was not found.',
          })
          return
        }

        const shouldApplyPenalty = shouldApplyTableExitPenalty(room)
        const stakeAmount = room.config.stakeAmount ?? null
        let exitPenalty:
          | {
              penaltyAmount: number
              chargedAmount: number
              balanceAfter: number
            }
          | undefined

        if (shouldApplyPenalty) {
          const participantProfileId =
            participant.identity.profileId ?? participant.publicProfile?.profileId ?? null

          if (participantProfileId === null) {
            safeSendToConnection(connection.id, {
              type: 'error',
              message: 'Само регистриран профил може да напусне активна маса.',
            })
            return
          }

          if (message.acceptPenalty !== true) {
            safeSendToConnection(connection.id, {
              type: 'error',
              message: 'Потвърди санкцията за напускане на активната маса.',
            })
            return
          }

          if (!Number.isInteger(stakeAmount) || stakeAmount === null || stakeAmount <= 0) {
            safeSendToConnection(connection.id, {
              type: 'error',
              message: 'Невалиден залог за санкция при напускане.',
            })
            return
          }

          const penaltyResult = tableExitPenaltyStore.applyPenalty(
            participantProfileId,
            room.id,
            stakeAmount,
          )

          if (!penaltyResult.ok) {
            safeSendToConnection(connection.id, {
              type: 'error',
              message: penaltyResult.message,
            })
            return
          }

          exitPenalty = {
            penaltyAmount: penaltyResult.penalty.penaltyAmount,
            chargedAmount: penaltyResult.penalty.chargedAmount,
            balanceAfter: penaltyResult.penalty.balanceAfter,
          }
        }

        const currentLeaveVotes = room.leaveVotes ?? []
        const roomWithLeaveVote =
          isRoomAtMatchEndedPhase(room) && !currentLeaveVotes.includes(seat)
            ? {
                ...room,
                leaveVotes: [...currentLeaveVotes, seat],
                updatedAt: Date.now(),
              }
            : room

        const disconnectedParticipant = {
          ...markHumanParticipantDisconnected(
            participant,
            connection.id,
          ),
          reconnectToken: null,
          permanentlyLeftAt: Date.now(),
        }
        const disconnectedRoom = updateHumanParticipantInRoom(
          roomWithLeaveVote,
          seat,
          disconnectedParticipant,
        )
        // Турнирни мачове вече ползват СЪЩИЯ mid-match bot-handoff механизъм
        // (controlledByBot флаг върху human participant-а) като нормалните
        // маси — explicit "Напусни" по време на активен турнирен мач трябва
        // веднага да предаде хода на бота, а не да чака следващия bid/play
        // timeout. Самата икономика остава изолирана (§11 в task spec-а):
        // shouldApplyTableExitPenalty вече изключва турнирни стаи по-горе,
        // защото те се създават с stakeAmount:0 — тук само seat control
        // handoff, никаква tournament-related такса.
        const abandonResult = activeRoomRuntime.abandonHumanControl({
          room: disconnectedRoom,
          seat,
        })
        const nextRoom = abandonResult.ok ? abandonResult.room : disconnectedRoom

        if (!abandonResult.ok) {
          console.error(
            `[leave-active-room] failed to hand seat to bot room=${room.id} seat=${seat}: ${abandonResult.message}`,
          )
        }

        const detachedConnection = detachConnectionFromRoomSeat(
          latestConnection,
          connection.id,
        )

        serverState = commitServerRoomWithSnapshot(nextRoom)
        serverState = updateServerConnectionInState(
          serverState,
          connection.id,
          detachedConnection,
        )

        const roomWasRemoved = cleanupInactiveRoomIfNeeded(message.roomId)

        safeSendToConnection(connection.id, {
          type: 'left_active_room',
          roomId: message.roomId,
          removed: roomWasRemoved,
          penalty: exitPenalty,
        })

        if (!roomWasRemoved) {
          broadcastRoomSnapshots(nextRoom, socketRegistry)
        }

        return
      }

      if (message.type === 'create_room') {
        removeConnectionFromMatchmaking(connection.id)

        const createRoomConnection = getConnectionById(serverState, connection.id)
        const createRoomPublicProfile =
          createRoomConnection?.profileId != null
            ? playerProgressStore.getPublicProfile(createRoomConnection.profileId)
            : null

        if (
          createRoomConnection?.profileId != null &&
          sendSessionInGameIfNeeded(connection.id, createRoomConnection.profileId)
        ) {
          return
        }

        const result = handleCreateRoom(
          serverState,
          connection.id,
          message.displayName,
          createRoomPublicProfile,
        )

        const initializedRoom = initializeRoomAuthoritativeGameState(result.room)

        const ensureResult = activeRoomRuntime.ensureRoom(initializedRoom)
        if (!ensureResult.ok) {
          console.error(
            `[create-room] no runtime capacity for room=${initializedRoom.id}: ${ensureResult.reason}`,
          )
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Не може да се създаде маса в момента.',
          })
          return
        }

        serverState = commitServerRoomWithSnapshot(initializedRoom, result.serverState)

        sendJsonMessage(socket, {
          type: 'room_created',
          roomId: initializedRoom.id,
          seat: result.seat,
          hostDisplayName: result.connection.playerId
            ? initializedRoom.seats[result.seat].participant?.identity.displayName ?? 'Гост'
            : 'Гост',
        })

        broadcastRoomSnapshots(initializedRoom, socketRegistry)
        return
      }

      if (message.type === 'join_room') {
        removeConnectionFromMatchmaking(connection.id)

        const joinRoomConnection = getConnectionById(serverState, connection.id)
        const joinRoomPublicProfile =
          joinRoomConnection?.profileId != null
            ? playerProgressStore.getPublicProfile(joinRoomConnection.profileId)
            : null

        if (
          joinRoomConnection?.profileId != null &&
          sendSessionInGameIfNeeded(connection.id, joinRoomConnection.profileId)
        ) {
          return
        }

        const result = handleJoinRoom(
          serverState,
          connection.id,
          message.roomId,
          message.displayName,
          joinRoomPublicProfile,
        )

        const initializedRoom = initializeRoomAuthoritativeGameState(result.room)

        serverState = commitServerRoomWithSnapshot(initializedRoom, result.serverState)
        activeRoomRuntime.ensureRoom(initializedRoom)

        sendJsonMessage(socket, {
          type: 'room_joined',
          roomId: initializedRoom.id,
          seat: result.seat,
          displayName:
            initializedRoom.seats[result.seat].participant?.identity.displayName ?? 'Гост',
        })

        broadcastRoomSnapshots(initializedRoom, socketRegistry)
        return
      }

      if (message.type === 'request_private_rooms_list') {
        const latestConnection = getConnectionById(serverState, connection.id)
        if (latestConnection?.profileId != null) {
          const reconnected = privateRoomsStore.reconnectMember(connection.id, latestConnection.profileId)
          if (reconnected !== null) {
            safeSendToConnection(connection.id, {
              type: 'private_room_updated',
              room: buildPrivateRoomSnapshot(reconnected),
            })
          }
        }
        const snapshots = privateRoomsStore.listRooms().map(buildPrivateRoomSnapshot)
        safeSendToConnection(connection.id, { type: 'private_rooms_list', rooms: snapshots })
        return
      }

      if (message.type === 'request_private_games_list') {
        safeSendToConnection(connection.id, buildPrivateGamesListMessage())
        return
      }

      if (message.type === 'create_private_room') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection?.profileId == null) {
          safeSendToConnection(connection.id, { type: 'error', message: 'Трябва да влезеш в профила си.' })
          return
        }

        if (sendSessionInGameIfNeeded(connection.id, latestConnection.profileId)) {
          return
        }

        const publicProfile = playerProgressStore.getPublicProfile(latestConnection.profileId)

        if (publicProfile === null) {
          safeSendToConnection(connection.id, { type: 'error', message: 'Профилът не беше намерен.' })
          return
        }

        const eligibility = checkPrivateRoomStakeEligibility(
          latestConnection.profileId,
          publicProfile.level,
          message.stake,
        )
        if (!eligibility.ok) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: eligibility.message,
            code: eligibility.code,
          })
          return
        }

        const createResult = privateRoomsStore.createRoom({
          connectionId: connection.id,
          profileId: latestConnection.profileId,
          displayName: publicProfile.displayName,
          avatarUrl: publicProfile.avatarUrl,
          level: publicProfile.level,
          rankTitle: publicProfile.rankTitle,
          stake: message.stake,
          isLocked: message.isLocked,
          waitMinutes: message.waitMinutes,
          manualStart: message.manualStart ?? false,
        })

        if (!createResult.ok) {
          safeSendToConnection(connection.id, { type: 'error', message: createResult.message })
          return
        }

        activityCounters.incrementRooms('privateRoomCreate')

        safeSendToConnection(connection.id, {
          type: 'private_room_updated',
          room: buildPrivateRoomSnapshot(createResult.room),
        })

        broadcastPrivateRoomCreatedNotice({
          creatorProfileId: latestConnection.profileId,
          creatorDisplayName: publicProfile.displayName,
          creatorAvatarUrl: publicProfile.avatarUrl,
          roomId: createResult.room.id,
        })
        return
      }

      if (message.type === 'join_private_room') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection?.profileId == null) {
          safeSendToConnection(connection.id, { type: 'error', message: 'Трябва да влезеш в профила си.' })
          return
        }

        if (sendSessionInGameIfNeeded(connection.id, latestConnection.profileId)) {
          return
        }

        const publicProfile = playerProgressStore.getPublicProfile(latestConnection.profileId)

        if (publicProfile === null) {
          safeSendToConnection(connection.id, { type: 'error', message: 'Профилът не беше намерен.' })
          return
        }

        const targetPrivateRoom = privateRoomsStore
          .listRooms()
          .find((r) => r.id === message.privateRoomId)

        if (targetPrivateRoom !== undefined) {
          const eligibility = checkPrivateRoomStakeEligibility(
            latestConnection.profileId,
            publicProfile.level,
            targetPrivateRoom.stake,
          )
          if (!eligibility.ok) {
            safeSendToConnection(connection.id, {
              type: 'error',
              message: eligibility.message,
              code: eligibility.code,
            })
            return
          }
        }

        const joinResult = privateRoomsStore.joinTeam({
          privateRoomId: message.privateRoomId,
          connectionId: connection.id,
          profileId: latestConnection.profileId,
          displayName: publicProfile.displayName,
          avatarUrl: publicProfile.avatarUrl,
          level: publicProfile.level,
          rankTitle: publicProfile.rankTitle,
          team: message.team,
          slotIndex: message.slotIndex,
          isBlockedWith: (a, b) => blockStore.isBlocked(a, b),
        })

        if (!joinResult.ok) {
          safeSendToConnection(connection.id, { type: 'error', message: joinResult.message, code: joinResult.code })
          return
        }

        activityCounters.incrementRooms('privateRoomJoin')

        if (!joinResult.readyToStart) {
          sendPrivateRoomUpdateToMembers(joinResult.room)
          if (joinResult.readiness && !joinResult.readiness.ready) {
            broadcastPrivateRoomNotReadyInfo(joinResult.room, joinResult.readiness)
          }
        }
        return
      }

      if (message.type === 'leave_private_room') {
        const privateRoom = privateRoomsStore.getRoomByConnectionId(connection.id)
        const isLastHuman = privateRoom !== null && getHumanCount(privateRoom) <= 1

        const remainingRoom = privateRoomsStore.leaveRoom(connection.id)
        if (privateRoom !== null) {
          activityCounters.incrementRooms('privateRoomLeave')
        }
        if (isLastHuman && privateRoom !== null) {
          // Room was silently deleted (last human left) — no
          // onRoomClosed/onRoomExpired callback fires for this path, so
          // clear the ephemeral chat here explicitly.
          privateRoomChatStore.clearRoom(privateRoom.id)
        } else if (remainingRoom !== null) {
          // Remaining members (including a newly-reassigned host) must see
          // the fresh room state in realtime — the departed occupant's slot
          // clearing, orphan-bot removal, and any host reassignment. Without
          // this, onMemberLeft only sends the new host a text notification
          // (private_room_member_left), never an updated room snapshot, so
          // state.myPrivateRoom on every remaining client stays stale until
          // an unrelated event (or a hard refresh) happens to refetch it.
          sendPrivateRoomUpdateToMembers(remainingRoom)
        }

        safeSendToConnection(connection.id, {
          type: 'private_room_left',
          privateRoomId: privateRoom?.id ?? '',
        })
        return
      }

      if (message.type === 'add_bot_to_private_room_team') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection?.profileId == null) {
          safeSendToConnection(connection.id, { type: 'error', message: 'Трябва да влезеш в профила си.' })
          return
        }

        const room = privateRoomsStore.getRoomByConnectionId(connection.id)
        if (room === null) {
          safeSendToConnection(connection.id, { type: 'error', message: 'Не си в частна маса.' })
          return
        }

        const callerSlot = room.slots.find(
          (s) => s.team === message.team && s.occupant?.kind === 'human' && s.occupant.connectionId === connection.id,
        )
        if (callerSlot === undefined) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: 'Само играч от този отбор може да добавя бот тук.',
            code: 'private_room_bot_owner_missing',
          })
          return
        }

        const hasEmptySlot = room.slots.some((s) => s.team === message.team && s.occupant === null)
        if (!hasEmptySlot) {
          safeSendToConnection(connection.id, { type: 'error', message: 'Отборът е пълен.', code: 'private_room_team_full' })
          return
        }

        // Точка 3 (втори review кръг): изключваме вече заетите в тази стая
        // bot profileId-та, за да не се стигне до дублирана bot identity,
        // ако Team A и Team B добавят ботове в различни моменти.
        const existingBotProfileIds = room.slots
          .map((s) => s.occupant)
          .filter((o): o is PrivateRoomBotOccupant => o !== null && o.kind === 'bot' && o.botProfileId != null)
          .map((o) => o.botProfileId as string)

        const selectedBotProfiles = selectMatchmakingBotProfiles({
          stake: room.stake,
          count: 1,
          selectionSeed: `private-room-team-fill:${room.id}:${message.team}`,
          excludedProfileIds: existingBotProfileIds,
          createTempBot: (stake, profileId, baseName, completedGamesCount, wonGamesCount) => {
            const stakeMinLevel = matchRoomsStore.getRoom(stake)?.minLevel ?? 1
            if (stakeMinLevel > 7) return null
            const profile = playerProgressStore.createTemporaryBotProfile(profileId, baseName, completedGamesCount, wonGamesCount)
            return profile.displayName
          },
        })

        const selectedBotProfile = selectedBotProfiles[0]
        if (selectedBotProfile === undefined) {
          safeSendToConnection(connection.id, { type: 'error', message: 'Не успяхме да намерим свободен бот.' })
          return
        }

        const botOccupant: PrivateRoomBotOccupant = {
          kind: 'bot',
          botProfileId: selectedBotProfile.profileId ?? undefined,
          botCode: selectedBotProfile.code,
          difficulty: selectedBotProfile.difficulty,
          behaviorPreset: selectedBotProfile.behaviorPreset,
          logicSource: selectedBotProfile.logicSource,
          identity: selectedBotProfile.identity,
        }

        const addResult = privateRoomsStore.addBotToTeam({
          connectionId: connection.id,
          team: message.team,
          botOccupant,
          isBlockedWith: (a, b) => blockStore.isBlocked(a, b),
        })

        if (!addResult.ok) {
          safeSendToConnection(connection.id, { type: 'error', message: addResult.message, code: addResult.code })
          return
        }

        if (!addResult.readyToStart) {
          sendPrivateRoomUpdateToMembers(addResult.room)
          if (addResult.readiness && !addResult.readiness.ready) {
            broadcastPrivateRoomNotReadyInfo(addResult.room, addResult.readiness)
          }
        }
        return
      }

      if (message.type === 'remove_bot_from_private_room_team') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection?.profileId == null) {
          safeSendToConnection(connection.id, { type: 'error', message: 'Трябва да влезеш в профила си.' })
          return
        }

        const removeResult = privateRoomsStore.removeBotFromTeam({
          connectionId: connection.id,
          team: message.team,
        })

        if (!removeResult.ok) {
          safeSendToConnection(connection.id, { type: 'error', message: removeResult.message, code: removeResult.code })
          return
        }

        sendPrivateRoomUpdateToMembers(removeResult.room)
        return
      }

      if (message.type === 'start_private_room') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection?.profileId == null) {
          safeSendToConnection(connection.id, { type: 'error', message: 'Трябва да влезеш в профила си.' })
          return
        }

        const startResult = privateRoomsStore.startRoom({
          connectionId: connection.id,
          isBlockedWith: (a, b) => blockStore.isBlocked(a, b),
        })

        if (!startResult.ok) {
          safeSendToConnection(connection.id, { type: 'error', message: startResult.message, code: startResult.code })
          if (startResult.readiness && !startResult.readiness.ready) {
            const room = privateRoomsStore.getRoomByConnectionId(connection.id)
            if (room !== null) {
              broadcastPrivateRoomNotReadyInfo(room, startResult.readiness)
            }
          }
          return
        }

        // Успешен старт делегира изцяло на onRoomReady callback-а
        // (handlePrivateRoomReady), точно както auto-start пътя през
        // joinTeam/addBotToTeam — не дублира match-start логика тук.
        return
      }

      if (message.type === 'kick_from_private_room') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection?.profileId == null) {
          safeSendToConnection(connection.id, { type: 'error', message: 'Трябва да влезеш в профила си.' })
          return
        }

        const kickResult = privateRoomsStore.kickMember({
          connectionId: connection.id,
          team: message.team,
          slotIndex: message.slotIndex,
        })

        if (!kickResult.ok) {
          safeSendToConnection(connection.id, { type: 'error', message: kickResult.message, code: kickResult.code })
          return
        }

        sendPrivateRoomUpdateToMembers(kickResult.room)
        return
      }

      if (message.type === 'subscribe_private_room_chat') {
        const room = privateRoomsStore.getRoomByConnectionId(connection.id)

        if (room === null || room.id !== message.privateRoomId) {
          safeSendToConnection(connection.id, {
            type: 'private_room_chat_error',
            code: 'not_member',
            message: 'Не си в тази чакалня.',
          })
          return
        }

        const history = privateRoomChatStore
          .listRecentMessages(room.id)
          .slice(-PRIVATE_ROOM_CHAT_HISTORY_LIMIT)

        safeSendToConnection(connection.id, {
          type: 'private_room_chat_history',
          privateRoomId: room.id,
          messages: history,
        })
        return
      }

      if (message.type === 'unsubscribe_private_room_chat') {
        // Няма отделен subscriber Set за освобождаване — доставката винаги
        // се извежда наново от текущото членство в privateRoomsStore (виж
        // send_private_room_chat_message по-долу), затова тук няма какво да
        // се почисти. Съобщението съществува само за симетричен client-side
        // lifecycle hook.
        return
      }

      if (message.type === 'send_private_room_chat_message') {
        const requestId = message.requestId

        function sendPrivateRoomChatError(code: PrivateRoomChatErrorCode, errorMessage: string): void {
          safeSendToConnection(connection.id, {
            type: 'private_room_chat_error',
            code,
            message: errorMessage,
            ...(requestId ? { requestId } : {}),
          })
        }

        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection?.profileId == null) {
          sendPrivateRoomChatError('not_authenticated', 'Трябва да влезеш в профила си.')
          return
        }

        const room = privateRoomsStore.getRoomByConnectionId(connection.id)

        if (room === null || room.id !== message.privateRoomId) {
          sendPrivateRoomChatError('not_member', 'Не си в тази чакалня.')
          return
        }

        const senderSlot = room.slots.find((s) => s.occupant?.kind === 'human' && s.occupant.connectionId === connection.id)
        const senderMember = senderSlot?.occupant as PrivateRoomHumanOccupant | undefined

        if (senderMember === undefined) {
          sendPrivateRoomChatError('not_member', 'Не си в тази чакалня.')
          return
        }

        const validation = validatePrivateRoomChatBody(message.body)

        if (!validation.ok) {
          const messagesByCode: Record<typeof validation.code, string> = {
            empty_body: 'Съобщението не може да бъде празно.',
            body_too_long: `Съобщението може да е най-много ${PRIVATE_ROOM_CHAT_MAX_BODY_CODE_POINTS} символа.`,
            invalid_body: 'Съобщението съдържа неразрешени символи.',
          }
          sendPrivateRoomChatError(validation.code, messagesByCode[validation.code])
          return
        }

        const sendResult = privateRoomChatStore.sendMessage(room.id, {
          senderProfileId: senderMember.profileId,
          senderDisplayName: senderMember.displayName,
          body: validation.body,
        })

        if (!sendResult.ok) {
          const errorMessagesByCode: Record<typeof sendResult.code, string> = {
            rate_limited: 'Твърде много съобщения. Изчакай малко и опитай пак.',
            duplicate_message: 'Вече изпрати това съобщение.',
          }
          sendPrivateRoomChatError(sendResult.code, errorMessagesByCode[sendResult.code])
          return
        }

        activityCounters.incrementChat('privateRoomChatMessages')

        for (const slot of room.slots) {
          if (slot.occupant?.kind === 'human') {
            safeSendToConnection(slot.occupant.connectionId, {
              type: 'private_room_chat_message',
              privateRoomId: room.id,
              ...sendResult.message,
              ...(slot.occupant.connectionId === connection.id && requestId ? { requestId } : {}),
            })
          }
        }
        return
      }

      if (message.type === 'invite_to_private_room') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection?.profileId == null) {
          safeSendToConnection(connection.id, { type: 'error', message: 'Трябва да влезеш в профила си.' })
          return
        }

        const hostPublicProfile = playerProgressStore.getPublicProfile(latestConnection.profileId)
        const busyFriends: Array<{ displayName: string }> = []

        for (const toProfile of message.toProfiles) {
          if (isProfileInActiveGame(toProfile.profileId)) {
            busyFriends.push({ displayName: toProfile.displayName })
            continue
          }

          const inviteResult = privateRoomsStore.inviteFriend({
            senderConnectionId: connection.id,
            toProfileId: toProfile.profileId,
            toDisplayName: toProfile.displayName,
          })

          if (!inviteResult.ok) continue

          const expiresAt = Date.now() + 60_000
          schedulePrivateRoomInviteExpiry(inviteResult.invite.inviteId, toProfile.profileId, expiresAt)

          const targetConn = Object.values(serverState.connections).find(
            (c) => c.profileId === toProfile.profileId && c.status === 'connected',
          )
          if (targetConn) {
            safeSendToConnection(targetConn.id, {
              type: 'private_room_invite_received',
              inviteId: inviteResult.invite.inviteId,
              fromProfileId: inviteResult.invite.fromProfileId,
              fromDisplayName: inviteResult.invite.fromDisplayName,
              fromAvatarUrl: hostPublicProfile?.avatarUrl ?? null,
              privateRoomId: inviteResult.invite.privateRoomId,
              stake: inviteResult.room.stake,
              expiresAt,
            })
          }
        }

        if (busyFriends.length > 0) {
          safeSendToConnection(connection.id, { type: 'private_room_friend_busy', busyFriends })
        }

        const updatedRoom = privateRoomsStore.getRoomByConnectionId(connection.id)
        if (updatedRoom) sendPrivateRoomUpdateToMembers(updatedRoom)
        return
      }

      if (message.type === 'cancel_private_room_invite') {
        const room = privateRoomsStore.getRoomByConnectionId(connection.id)
        if (!room) return

        const cancelResult = privateRoomsStore.cancelInvite(message.inviteId, connection.id)
        if (!cancelResult.ok) return

        cancelPrivateRoomInviteTimer(message.inviteId)

        const inviteeConn = Object.values(serverState.connections).find(
          (c) => c.profileId === cancelResult.invite.toProfileId && c.status === 'connected',
        )
        if (inviteeConn) {
          safeSendToConnection(inviteeConn.id, {
            type: 'private_room_invite_cancelled',
            inviteId: message.inviteId,
          })
        }

        const updatedRoom = privateRoomsStore.getRoomByConnectionId(connection.id)
        if (updatedRoom) sendPrivateRoomUpdateToMembers(updatedRoom)
        return
      }

      if (message.type === 'respond_private_room_invite') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection?.profileId == null) {
          safeSendToConnection(connection.id, { type: 'error', message: 'Трябва да влезеш в профила си.' })
          return
        }

        if (sendSessionInGameIfNeeded(connection.id, latestConnection.profileId)) {
          return
        }

        const publicProfile = playerProgressStore.getPublicProfile(latestConnection.profileId)

        if (publicProfile === null) {
          safeSendToConnection(connection.id, { type: 'error', message: 'Профилът не беше намерен.' })
          return
        }

        const respondResult = privateRoomsStore.respondToInvite({
          inviteId: message.inviteId,
          profileId: latestConnection.profileId,
          accept: message.accept,
        })

        if (!respondResult.ok) {
          safeSendToConnection(connection.id, { type: 'error', message: respondResult.message })
          return
        }

        const hostConn = Object.values(serverState.connections).find(
          (c) => c.profileId === respondResult.room.hostProfileId && c.status === 'connected',
        )

        if (message.accept) {
          if (hostConn) {
            safeSendToConnection(hostConn.id, {
              type: 'private_room_invite_accepted',
              toDisplayName: publicProfile.displayName,
            })
          }
          // Не сяда автоматично — само дава room-lifetime authorization (виж
          // privateRoomsStore.authorizedProfileIds). Клиентът навигира сам
          // към preview на стаята чрез privateRoomId; реалният seat claim
          // минава през join_private_room{team,slotIndex}, както при open
          // стаите.
          safeSendToConnection(connection.id, {
            type: 'private_room_invite_accept_confirmed',
            privateRoomId: respondResult.room.id,
          })
        } else {
          if (hostConn) {
            safeSendToConnection(hostConn.id, {
              type: 'private_room_invite_declined',
              toDisplayName: publicProfile.displayName,
            })
          }
        }
        return
      }

      if (message.type === 'subscribe_lobby_chat') {
        lobbyChatSubscriberConnectionIds.add(connection.id)

        const latestConnection = getConnectionById(serverState, connection.id)
        const excludedSenderProfileIds = latestConnection?.profileId != null
          ? [...getLobbyChatBlockedSet(latestConnection.profileId)]
          : []

        const history = lobbyChatStore.listRecentMessages(
          LOBBY_CHAT_HISTORY_LIMIT,
          excludedSenderProfileIds,
          lobbyChatPikaAnnouncementCutoffSeq,
        )

        safeSendToConnection(connection.id, {
          type: 'lobby_chat_history',
          messages: history.map((m) => ({
            seq: m.seq,
            messageId: m.messageId,
            senderProfileId: m.senderProfileId,
            senderDisplayName: m.senderDisplayName,
            senderIsChatAdmin: m.senderIsChatAdmin,
            senderRole: m.senderRole,
            body: m.body,
            createdAt: m.createdAt,
          })),
        })
        return
      }

      if (message.type === 'unsubscribe_lobby_chat') {
        lobbyChatSubscriberConnectionIds.delete(connection.id)
        return
      }

      if (message.type === 'send_lobby_chat_message') {
        const requestId = message.requestId
        const latestConnection = getConnectionById(serverState, connection.id)

        function sendLobbyChatError(code: LobbyChatErrorCode, errorMessage: string): void {
          safeSendToConnection(connection.id, {
            type: 'lobby_chat_error',
            code,
            message: errorMessage,
            ...(requestId ? { requestId } : {}),
          })
        }

        if (latestConnection?.profileId == null) {
          sendLobbyChatError('not_authenticated', 'Трябва да влезеш в профила си, за да пишеш в чата.')
          return
        }

        if (playerProgressStore.isTemporaryProfile(latestConnection.profileId)) {
          sendLobbyChatError('guest_not_allowed', 'Общ чат само за регистрирани потребители.')
          return
        }

        const senderRoleForGate = authStore.getAccountRoleForProfile(latestConnection.profileId) ?? 'player'
        if (senderRoleForGate !== 'admin' && senderRoleForGate !== 'pika_team') {
          sendLobbyChatError('forbidden', 'Само екипът на Pika.bg може да публикува тук.')
          return
        }

        const validation = validateLobbyChatBody(message.body)

        if (!validation.ok) {
          const messagesByCode: Record<typeof validation.code, string> = {
            empty_body: 'Съобщението не може да бъде празно.',
            body_too_long: `Съобщението може да е най-много ${LOBBY_CHAT_MAX_BODY_CODE_POINTS} символа.`,
            invalid_body: 'Съобщението съдържа неразрешени символи.',
          }
          sendLobbyChatError(validation.code, messagesByCode[validation.code])
          return
        }

        if (!checkLobbyChatRateLimit(latestConnection.profileId)) {
          sendLobbyChatError('rate_limited', 'Твърде много съобщения. Изчакай малко и опитай пак.')
          return
        }

        if (isDuplicateLobbyChatMessage(latestConnection.profileId, validation.body)) {
          sendLobbyChatError('duplicate_message', 'Вече изпрати това съобщение.')
          return
        }

        const publicProfile = playerProgressStore.getPublicProfile(latestConnection.profileId)
        const senderDisplayName = publicProfile?.displayName?.trim() || 'Играч'
        const senderRole = senderRoleForGate
        // senderRoleForGate е стеснен до 'admin' | 'pika_team' от write gate-а
        // по-горе — chat_admin вече не може да изпраща тук, значи винаги false.
        const senderIsChatAdmin = false

        const snapshot = lobbyChatStore.insertMessage({
          senderProfileId: latestConnection.profileId,
          senderDisplayName,
          senderIsChatAdmin,
          senderRole,
          body: validation.body,
        })

        lobbyChatLastAnnouncedSeq = Math.max(lobbyChatLastAnnouncedSeq, snapshot.seq)
        recordLobbyChatSentMessage(latestConnection.profileId, validation.body)
        activityCounters.incrementChat('lobbyChatMessages')

        broadcastLobbyChatMessageToLocalSubscribers(snapshot, {
          originatingConnectionId: connection.id,
          requestId,
        })
        return
      }

      if (message.type === 'subscribe_topic_messages') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection?.profileId == null) {
          safeSendToConnection(connection.id, {
            type: 'topic_message_error',
            code: 'not_authenticated',
            message: 'Трябва да влезеш в профила си.',
          })
          return
        }

        if (playerProgressStore.isTemporaryProfile(latestConnection.profileId)) {
          safeSendToConnection(connection.id, {
            type: 'topic_message_error',
            code: 'guest_not_allowed',
            message: '„Теми“ само за регистрирани потребители.',
          })
          return
        }

        const profileId = latestConnection.profileId
        const topic = topicStore.getTopicById(message.topicId)
        if (topic === null) {
          safeSendToConnection(connection.id, {
            type: 'topic_message_error',
            code: 'topic_not_found',
            message: 'Темата не беше намерена.',
          })
          return
        }

        // Topics UX показва точно ЕДНА активна тема наведнъж — маха стария
        // subscription (ако имало различен topicId), регистрира новия.
        const previousTopicId = topicMessageSubscriberTopicIdByConnectionId.get(connection.id)
        if (previousTopicId !== undefined && previousTopicId !== message.topicId) {
          topicMessageSubscribersByTopicId.get(previousTopicId)?.delete(connection.id)
        }

        topicMessageSubscriberTopicIdByConnectionId.set(connection.id, message.topicId)
        let subscribers = topicMessageSubscribersByTopicId.get(message.topicId)
        if (subscribers === undefined) {
          subscribers = new Set()
          topicMessageSubscribersByTopicId.set(message.topicId, subscribers)
        }
        subscribers.add(connection.id)

        // Gap-closing catch-up (Етап 2 брифа т.1/т.8) — afterSeq=0 е валиден
        // baseline за тема без позната клиентска история; getMessagesAfter
        // просто връща всичко от началото до cap-а в този случай.
        const excludedSenderProfileIds = [...getLobbyChatBlockedSet(profileId)]
        const page = topicMessageStore.getMessagesAfter(
          message.topicId,
          message.afterSeq,
          TOPIC_MESSAGES_REALTIME_CATCHUP_LIMIT,
          excludedSenderProfileIds,
        )

        const hydratedCatchup = hydrateTopicMessagesWithCurrentAvatars(page.messages).map((m) => ({
          ...m,
          viewerHasLiked: viewerHasLikedMessage(m.messageId, profileId),
          unreadCount: getTopicThreadUnreadCountForProfile(profileId, m.messageId),
        }))

        // Seed-ва like drift-detection tracking set-а (runTopicMessageLikePoll)
        // с message-ите, които ТОЗИ subscriber вече вижда — без това, likes
        // toggle-нати на ДРУГ instance никога не биха влезли в tracking set-а
        // на текущия (той сам иначе seed-ва само при own local toggle, виж
        // коментара при runTopicMessageLikePoll).
        for (const m of hydratedCatchup) {
          if (!topicMessageLikeLastKnownCountByMessageId.has(m.messageId)) {
            topicMessageLikeLastKnownCountByMessageId.set(m.messageId, m.likeCount)
          }
        }

        safeSendToConnection(connection.id, {
          type: 'topic_message_catchup',
          topicId: message.topicId,
          messages: hydratedCatchup,
          truncated: page.hasMore,
        })
        if (!topic.isGeneral) {
          markTopicSeenForActiveProfile(profileId, message.topicId)
        }
        return
      }

      if (message.type === 'unsubscribe_topic_messages') {
        topicMessageSubscribersByTopicId.get(message.topicId)?.delete(connection.id)
        if (topicMessageSubscriberTopicIdByConnectionId.get(connection.id) === message.topicId) {
          topicMessageSubscriberTopicIdByConnectionId.delete(connection.id)
        }
        return
      }

      if (message.type === 'send_topic_message') {
        const requestId = message.requestId
        const requestTopicId = message.topicId
        const latestConnection = getConnectionById(serverState, connection.id)
        const imageDataUrlField = message.imageDataUrl

        function sendTopicMessageError(code: TopicMessageErrorCode, errorMessage: string): void {
          safeSendToConnection(connection.id, {
            type: 'topic_message_error',
            code,
            message: errorMessage,
            requestId,
            topicId: requestTopicId,
          })
        }

        if (latestConnection?.profileId == null) {
          sendTopicMessageError('not_authenticated', 'Трябва да влезеш в профила си.')
          return
        }

        // Capture-нато в локална const веднага след null check-а — TS
        // narrowing не преминава през closure boundary-я на async IIFE-то
        // по-долу, затова latestConnection.profileId (string | null) не би
        // се стеснил там без explicit локална string константа.
        const senderProfileId: string = latestConnection.profileId

        if (playerProgressStore.isTemporaryProfile(senderProfileId)) {
          sendTopicMessageError('guest_not_allowed', '„Теми“ само за регистрирани потребители.')
          return
        }

        // VIP guard — server е source of truth, независимо какво клиентският
        // composer показва локално (Етап 2 брифа: "Frontend скриването НЕ е
        // security boundary"). Ако VIP е изтекъл между отваряне на composer-а
        // и send-а, клиентът получава 'vip_required' тук и re-fetch-ва
        // canonical статус (виж controller-а, т.5 от корекциите). Снимка е
        // писане, значи СЪЩИЯТ VIP guard важи за нея (Attachment брифа т.3).
        if (!vipStore.getStatus(latestConnection.profileId).isActive) {
          sendTopicMessageError('vip_required', 'Писането в „Теми“ изисква активен VIP.')
          return
        }

        const topic = topicStore.getTopicById(message.topicId)

        // removed третираме идентично на unknown (т.6 от корекциите) — НЕ
        // topic_locked за premahnata тема.
        if (topic === null || topic.status === 'removed') {
          sendTopicMessageError('topic_not_found', 'Темата не беше намерена.')
          return
        }

        // Server-authoritative lock check — computed at READ time (виж
        // topicModerationStore.getTopicLockSnapshot), НЕ static topic.status
        // enum сравнение. Естественият expiry на temporary lock-а НЕ обновява
        // topics.status автоматично (само ръчен unlock го прави directno) —
        // static enum четенето би останало 'locked' дори СЛЕД lockedUntil да
        // е минал, ако разчитахме на него тук (Топикс moderation брифа т.2:
        // "При изтичане: topic lock автоматично престава да блокира писането").
        const lockSnapshot = topicModerationStore.getTopicLockSnapshot(message.topicId)
        if (lockSnapshot?.isLocked) {
          sendTopicMessageError('topic_locked', 'Темата е заключена за писане.')
          return
        }

        // Global Topics-section mute (GLOBAL TOPICS MUTE брифа §1.B) — вече
        // НЕ topic-specific: root post е писане навсякъде в "Теми", значи
        // guard-ът важи независимо от message.topicId. Server-authoritative,
        // computed at read time (isProfileMutedInTopicsSection reuse-ва
        // СЪЩИЯ expiry-comparison pattern като lock-а по-горе). mutedUntil/
        // reason в грешката носят точните server-authoritative стойности —
        // клиентът НЕ трябва да разчита само на realtime push-а (брифа §9).
        const sectionMuteSnapshot = topicModerationStore.getSectionMuteSnapshot(senderProfileId)
        if (sectionMuteSnapshot.isMuted) {
          safeSendToConnection(connection.id, {
            type: 'topic_message_error',
            code: 'topic_muted',
            message: 'Временно сте заглушени в секция „Теми“.',
            requestId,
            mutedUntil: sectionMuteSnapshot.mutedUntil ?? undefined,
            topicId: message.topicId,
            reason: sectionMuteSnapshot.reason ?? undefined,
          })
          return
        }

        // Image processing е ЕДИНСТВЕНАТА async стъпка в целия WS message
        // handler flow — обвиваме остатъка в IIFE, за да можем да await-нем
        // sharp resize/webp конверсията преди insert. Всичко останало (error
        // responses, insert, broadcast) е непроменено спрямо синхронния flow.
        //
        // Rate limit е СЛЕД upload+validation (запазва established реда от
        // преди Attachment feature-а — виж checkTopicMessagesRealtime.ts
        // A8-A11): validation грешки (empty/too-long/invalid_body) НЕ трябва
        // да consume-ват rate limit slot, само реално ПРИЕТИ съобщения го
        // правят. Duplicate guard-ът е СЛЕД rate limit, симетрично на
        // оригиналния синхронен flow.
        void (async () => {
          const uploadResult = await createTopicAttachmentUpload(imageDataUrlField)

          if (!uploadResult.ok) {
            sendTopicMessageError(uploadResult.code, uploadResult.message)
            return
          }

          const validation = validateTopicMessageBody(message.body, uploadResult.attachmentInput !== null)

          if (!validation.ok) {
            const messagesByCode: Record<typeof validation.code, string> = {
              empty_body: 'Съобщението трябва да съдържа текст или снимка.',
              body_too_long: `Съобщението може да е най-много ${TOPIC_MESSAGE_MAX_BODY_CODE_POINTS} символа.`,
              invalid_body: 'Съобщението съдържа неразрешени символи.',
            }
            if (uploadResult.writtenAttachmentFilename !== null) {
              await deleteTopicAttachmentFileByFilename(uploadResult.writtenAttachmentFilename)
            }
            sendTopicMessageError(validation.code, messagesByCode[validation.code])
            return
          }

          if (!checkTopicMessageRateLimit(senderProfileId)) {
            if (uploadResult.writtenAttachmentFilename !== null) {
              await deleteTopicAttachmentFileByFilename(uploadResult.writtenAttachmentFilename)
            }
            sendTopicMessageError('rate_limited', 'Твърде много съобщения. Изчакай малко и опитай пак.')
            return
          }

          // Scoped по profileId+topicId+root (Етап 2 брифа т.7, Етап 3
          // разширение) — НЕ глобално per profile, за да не блокира легитимно
          // еднакъв кратък текст в две различни теми. Image-only съобщения
          // (body='') никога не се смятат за duplicate помежду си — празен
          // normalizedBody не носи информация за сравнение (реалният anti-spam
          // guard за самите снимки е rate limit-ът по-горе).
          if (validation.body.length > 0 && isDuplicateTopicMessage(senderProfileId, message.topicId, null, validation.body)) {
            if (uploadResult.writtenAttachmentFilename !== null) {
              await deleteTopicAttachmentFileByFilename(uploadResult.writtenAttachmentFilename)
            }
            sendTopicMessageError('duplicate_message', 'Вече изпрати това съобщение.')
            return
          }

          const publicProfile = playerProgressStore.getPublicProfile(senderProfileId)
          const senderDisplayName = publicProfile?.displayName?.trim() || 'Играч'
          const senderRole = authStore.getAccountRoleForProfile(senderProfileId) ?? 'player'

          let row: TopicMessageSnapshot
          try {
            row = topicMessageStore.insertMessage({
              topicId: message.topicId,
              senderProfileId,
              senderDisplayName,
              senderRole,
              body: validation.body,
              attachment: uploadResult.attachmentInput,
            })
          } catch (error) {
            // File-write-succeeded/DB-insert-failed — изтрий файла веднага,
            // не чакай orphan scan-а (виж Attachment брифа т.15).
            if (uploadResult.writtenAttachmentFilename !== null) {
              await deleteTopicAttachmentFileByFilename(uploadResult.writtenAttachmentFilename)
            }
            throw error
          }

          if (validation.body.length > 0) {
            recordTopicMessageSent(senderProfileId, message.topicId, null, validation.body)
          }

          activityCounters.incrementTopics(
            message.topicId === LAFCHE_TOPIC_ID ? 'lafcheRootsCreated' : 'topicRootsCreated',
          )

          // Local instant broadcast — маркира seq-а като locally-announced ПРЕДИ
          // broadcast (за да го хване следващият poll tick дори ако той изпревари
          // synchronous-ния return тук, което не би могло да стане в единствената
          // Node event loop нишка, но държим реда defensive- но правилен). ПОЛ
          // CURSOR-ЪТ СЪЗНАТЕЛНО НЕ СЕ ПИПА ТУК — виж инвариант коментара при
          // декларацията на topicMessagePollCursor по-горе във файла.
          topicMessageLocallyAnnouncedSeqs.set(row.seq, Date.now())
          const [hydrated] = hydrateTopicMessagesWithCurrentAvatars([row])
          if (hydrated) {
            broadcastTopicMessageToLocalSubscribers(message.topicId, hydrated, {
              originatingConnectionId: connection.id,
              requestId,
            })
          }

          // Lafche 200-post hard retention (production hotfix) — fire-and-
          // forget (serialized опашка, виж enqueueLafcheRetentionEnforcement),
          // СЛЕД broadcast-а (append-first, prune-after реда: новото
          // съобщение винаги стига до subscribers-ите ПРЕДИ евентуален
          // victim да бъде hard-deleted). Само за Lafche — normal Topics
          // pagination/history остава напълно непроменена.
          if (message.topicId === LAFCHE_TOPIC_ID) {
            enqueueLafcheRetentionEnforcement()
          }
        })().catch((error) => {
          console.error('[topics] send_topic_message attachment flow failed:', error)
          sendTopicMessageError('attachment_upload_failed', 'Съобщението не можа да бъде изпратено.')
        })
        return
      }

      if (message.type === 'send_topic_reply') {
        const requestId = message.requestId
        const requestTopicId = message.topicId
        const latestConnection = getConnectionById(serverState, connection.id)
        const imageDataUrlField = message.imageDataUrl

        function sendTopicReplyError(code: TopicReplyErrorCode, errorMessage: string): void {
          safeSendToConnection(connection.id, {
            type: 'topic_reply_error',
            code,
            message: errorMessage,
            requestId,
            topicId: requestTopicId,
          })
        }

        if (latestConnection?.profileId == null) {
          sendTopicReplyError('not_authenticated', 'Трябва да влезеш в профила си.')
          return
        }

        const senderProfileId: string = latestConnection.profileId

        if (playerProgressStore.isTemporaryProfile(senderProfileId)) {
          sendTopicReplyError('guest_not_allowed', '„Теми“ само за регистрирани потребители.')
          return
        }

        // VIP guard — reply е писане в Topics, идентично на root send (Етап 3
        // брифа: "Reply е писане в Topics" → "Server-side VIP guard е
        // задължителен и остава security boundary"). Снимка към reply е
        // писане, значи СЪЩИЯТ guard важи (Attachment брифа т.3).
        if (!vipStore.getStatus(senderProfileId).isActive) {
          sendTopicReplyError('vip_required', 'Писането в „Теми“ изисква активен VIP.')
          return
        }

        const topic = topicStore.getTopicById(message.topicId)
        if (topic === null || topic.status === 'removed') {
          sendTopicReplyError('topic_not_found', 'Темата не беше намерена.')
          return
        }

        // Server-authoritative, computed at read time — виж коментара в
        // send_topic_message за пълния rationale (static status enum не се
        // самообновява при естествен expiry).
        const lockSnapshot = topicModerationStore.getTopicLockSnapshot(message.topicId)
        if (lockSnapshot?.isLocked) {
          sendTopicReplyError('topic_locked', 'Темата е заключена за писане.')
          return
        }

        // Global Topics-section mute (GLOBAL TOPICS MUTE брифа §1.C) — виж
        // идентичния коментар в send_topic_message по-горе.
        const sectionMuteSnapshot = topicModerationStore.getSectionMuteSnapshot(senderProfileId)
        if (sectionMuteSnapshot.isMuted) {
          safeSendToConnection(connection.id, {
            type: 'topic_reply_error',
            code: 'topic_muted',
            message: 'Временно сте заглушени в секция „Теми“.',
            requestId,
            mutedUntil: sectionMuteSnapshot.mutedUntil ?? undefined,
            topicId: message.topicId,
            reason: sectionMuteSnapshot.reason ?? undefined,
          })
          return
        }

        const parent = topicMessageStore.getMessageById(message.parentMessageId)
        if (parent === null || parent.topicId !== message.topicId || parent.deletedAt !== null) {
          sendTopicReplyError('parent_not_found', 'Съобщението, на което отговаряш, не беше намерено.')
          return
        }
        // Едно ниво (Етап 3 продуктово решение) — reply винаги сочи ДИРЕКТНО
        // към ROOT съобщение. Ако parent самият е reply (parentMessageId !==
        // null), отхвърляме тук — UI никога не би трябвало да изложи Reply
        // контрола под reply row (виж renderTopicsScreen.ts), но server-ът
        // остава единствения authoritative guard.
        if (parent.parentMessageId !== null) {
          sendTopicReplyError('reply_to_reply_denied', 'Може да отговаряш само на основно съобщение.')
          return
        }

        // Rate limit е СЛЕД upload+validation — виж коментара в
        // send_topic_message за пълния rationale (established test поведение:
        // validation грешки не трябва да consume-ват rate limit slot).
        void (async () => {
          const uploadResult = await createTopicAttachmentUpload(imageDataUrlField)

          if (!uploadResult.ok) {
            sendTopicReplyError(uploadResult.code, uploadResult.message)
            return
          }

          const validation = validateTopicMessageBody(message.body, uploadResult.attachmentInput !== null)
          if (!validation.ok) {
            const messagesByCode: Record<typeof validation.code, string> = {
              empty_body: 'Съобщението трябва да съдържа текст или снимка.',
              body_too_long: `Съобщението може да е най-много ${TOPIC_MESSAGE_MAX_BODY_CODE_POINTS} символа.`,
              invalid_body: 'Съобщението съдържа неразрешени символи.',
            }
            if (uploadResult.writtenAttachmentFilename !== null) {
              await deleteTopicAttachmentFileByFilename(uploadResult.writtenAttachmentFilename)
            }
            sendTopicReplyError(validation.code, messagesByCode[validation.code])
            return
          }

          if (!checkTopicMessageRateLimit(senderProfileId)) {
            if (uploadResult.writtenAttachmentFilename !== null) {
              await deleteTopicAttachmentFileByFilename(uploadResult.writtenAttachmentFilename)
            }
            sendTopicReplyError('rate_limited', 'Твърде много съобщения. Изчакай малко и опитай пак.')
            return
          }

          if (
            validation.body.length > 0 &&
            isDuplicateTopicMessage(senderProfileId, message.topicId, message.parentMessageId, validation.body)
          ) {
            if (uploadResult.writtenAttachmentFilename !== null) {
              await deleteTopicAttachmentFileByFilename(uploadResult.writtenAttachmentFilename)
            }
            sendTopicReplyError('duplicate_message', 'Вече изпрати това съобщение.')
            return
          }

          const publicProfile = playerProgressStore.getPublicProfile(senderProfileId)
          const senderDisplayName = publicProfile?.displayName?.trim() || 'Играч'
          const senderRole = authStore.getAccountRoleForProfile(senderProfileId) ?? 'player'

          let row: TopicMessageSnapshot
          try {
            const insertResult = topicMessageStore.insertReply({
              topicId: message.topicId,
              parentMessageId: message.parentMessageId,
              senderProfileId,
              senderDisplayName,
              senderRole,
              body: validation.body,
              attachment: uploadResult.attachmentInput,
            })
            if (!insertResult.ok) {
              // Race: root-ът е бил soft-deleted (own-delete или moderator
              // delete) МЕЖДУ initial parent check-а по-горе и завършека на
              // upload-а — fresh re-check вътре в insertReply() транзакцията
              // хвана го (own-delete-own-content брифа §15).
              if (uploadResult.writtenAttachmentFilename !== null) {
                await deleteTopicAttachmentFileByFilename(uploadResult.writtenAttachmentFilename)
              }
              sendTopicReplyError('parent_not_found', 'Съобщението, на което отговаряш, не беше намерено.')
              return
            }
            row = insertResult.message
          } catch (error) {
            if (uploadResult.writtenAttachmentFilename !== null) {
              await deleteTopicAttachmentFileByFilename(uploadResult.writtenAttachmentFilename)
            }
            throw error
          }

          if (validation.body.length > 0) {
            recordTopicMessageSent(senderProfileId, message.topicId, message.parentMessageId, validation.body)
          }

          activityCounters.incrementTopics(
            message.topicId === LAFCHE_TOPIC_ID ? 'lafcheRepliesCreated' : 'topicRepliesCreated',
          )

          // Същия locally-announced+poll-cursor инвариант като root (Етап 3
          // разширение — виж коментара при pollNewMessagesStatement/
          // computeTopicMessagePollAdvance: parent-agnostic по дизайн).
          topicMessageLocallyAnnouncedSeqs.set(row.seq, Date.now())
          const [hydrated] = hydrateTopicMessagesWithCurrentAvatars([row])
          if (hydrated && hydrated.parentMessageId !== null) {
            const { replyCount: _replyCount, ...replyBase } = hydrated
            broadcastTopicReplyToLocalSubscribers(message.topicId, { ...replyBase, parentMessageId: hydrated.parentMessageId }, {
              originatingConnectionId: connection.id,
              requestId,
            })
          }
        })().catch((error) => {
          console.error('[topics] send_topic_reply attachment flow failed:', error)
          sendTopicReplyError('attachment_upload_failed', 'Отговорът не можа да бъде изпратен.')
        })
        return
      }

      if (message.type === 'toggle_topic_message_like') {
        const requestId = message.requestId
        const latestConnection = getConnectionById(serverState, connection.id)

        function sendTopicLikeError(code: TopicMessageLikeErrorCode, errorMessage: string): void {
          safeSendToConnection(connection.id, {
            type: 'topic_message_like_error',
            code,
            message: errorMessage,
            requestId,
          })
        }

        if (latestConnection?.profileId == null) {
          sendTopicLikeError('not_authenticated', 'Трябва да влезеш в профила си.')
          return
        }

        if (playerProgressStore.isTemporaryProfile(latestConnection.profileId)) {
          sendTopicLikeError('guest_not_allowed', '„Теми“ само за регистрирани потребители.')
          return
        }

        // Likes НЕ са VIP функция (Етап 3 брифа) — само auth + not-guest guard,
        // никакъв vipStore.getStatus() lookup тук.

        const targetMessage = topicMessageStore.getMessageById(message.messageId)
        if (targetMessage === null || targetMessage.deletedAt !== null) {
          sendTopicLikeError('message_not_found', 'Съобщението не беше намерено.')
          return
        }

        // Отделен, по-хлабав bucket от root/reply send (Етап 3 брифа: "не
        // използвай същия много строг message-send лимит").
        if (!checkTopicMessageLikeRateLimit(latestConnection.profileId)) {
          sendTopicLikeError('rate_limited', 'Твърде много действия. Изчакай малко и опитай пак.')
          return
        }

        // toggleLike прави BEGIN IMMEDIATE транзакция вътрешно (store слой) —
        // PRIMARY KEY(message_id, liker_profile_id) е ultimate correctness
        // arbiter (Етап 3 брифа т.7: "DB constraint е final correctness",
        // rapid double-click/multiple tabs решени на DB ниво, не тук).
        const { likeCount, viewerHasLiked } = topicMessageStore.toggleLike(message.messageId, latestConnection.profileId)

        // Маркираме за drift-detection polling-а (виж
        // runTopicMessageLikePoll) — same-instance echo suppression,
        // аналогично на topicMessageLocallyAnnouncedSeqs за root/reply.
        topicMessageLikeLocallyAnnouncedAt.set(message.messageId, Date.now())
        topicMessageLikeLastKnownCountByMessageId.set(message.messageId, likeCount)

        // PUBLIC broadcast — само messageId+likeCount, НИКАКВА liker identity.
        broadcastTopicMessageLikeChangedToLocalSubscribers(targetMessage.topicId, message.messageId, likeCount)

        // PRIVATE ack — само към toggle-ващия connection, носи viewerHasLiked.
        safeSendToConnection(connection.id, {
          type: 'topic_message_like_changed_self',
          messageId: message.messageId,
          likeCount,
          viewerHasLiked,
          requestId,
        })
        return
      }

      if (message.type === 'subscribe_topics_directory') {
        topicsDirectorySubscriberConnectionIds.add(connection.id)
        return
      }

      if (message.type === 'unsubscribe_topics_directory') {
        topicsDirectorySubscriberConnectionIds.delete(connection.id)
        return
      }

      if (message.type === 'create_topic') {
        const requestId = message.requestId
        const latestConnection = getConnectionById(serverState, connection.id)

        function sendTopicCreateError(code: TopicCreateErrorCode, errorMessage: string): void {
          safeSendToConnection(connection.id, {
            type: 'topic_create_error',
            code,
            message: errorMessage,
            requestId,
          })
        }

        if (latestConnection?.profileId == null) {
          sendTopicCreateError('not_authenticated', 'Трябва да влезеш в профила си.')
          return
        }

        const creatorProfileId: string = latestConnection.profileId

        if (playerProgressStore.isTemporaryProfile(creatorProfileId)) {
          sendTopicCreateError('guest_not_allowed', '„Теми“ само за регистрирани потребители.')
          return
        }

        // VIP guard — reuse на СЪЩИЯ established Topics write eligibility
        // guard като send_topic_message/send_topic_reply (виж CLAUDE.md /
        // Топикс брифовете) — server е source of truth, "+" клик на клиента е
        // само UX, не security boundary.
        if (!vipStore.getStatus(creatorProfileId).isActive) {
          sendTopicCreateError('vip_required', 'Създаването на теми изисква активен VIP.')
          return
        }

        // Global Topics-section mute guard (GLOBAL TOPICS MUTE брифа §1.A) —
        // create-topic е писане в секция "Теми", значи същият enforcement
        // guard важи, идентично на send_topic_message/send_topic_reply
        // по-долу. Server-authoritative, computed at read time.
        const sectionMuteSnapshot = topicModerationStore.getSectionMuteSnapshot(creatorProfileId)
        if (sectionMuteSnapshot.isMuted) {
          safeSendToConnection(connection.id, {
            type: 'topic_create_error',
            code: 'topic_muted',
            message: 'Временно сте заглушени в секция „Теми“.',
            requestId,
            mutedUntil: sectionMuteSnapshot.mutedUntil ?? undefined,
            reason: sectionMuteSnapshot.reason ?? undefined,
          })
          return
        }

        const validation = validateTopicTitle(message.title)
        if (!validation.ok) {
          const messagesByCode: Record<typeof validation.code, string> = {
            empty_title: 'Името на темата не може да бъде празно.',
            title_too_long: `Името може да е най-много ${TOPIC_TITLE_MAX_CODE_POINTS} символа.`,
            invalid_title: 'Името съдържа неразрешени символи.',
          }
          sendTopicCreateError(validation.code, messagesByCode[validation.code])
          return
        }

        // Established ред: rate limit СЛЕД validation (validation грешки не
        // консумират slot, mirror на send_topic_message конвенцията).
        if (!checkTopicCreateRateLimit(creatorProfileId)) {
          sendTopicCreateError('rate_limited', 'Твърде много създадени теми. Изчакай малко и опитай пак.')
          return
        }

        // Duplicate-check + insert е ЕДНА атомична BEGIN IMMEDIATE транзакция
        // вътре в topicStore.createTopic — виж коментара там за пълния
        // concurrency rationale. Две едновременни create заявки със same
        // normalized title НЕ могат и двете да минат — SQLite writer lock-ът
        // сериализира ги.
        const result = topicStore.createTopic({ title: validation.title, createdByProfileId: creatorProfileId })

        if (!result.ok) {
          sendTopicCreateError('topic_title_exists', 'Вече има тема с такова име.')
          return
        }

        // Напредваме directory poll cursor-а веднага при local create (mirror
        // на lobbyChatLastAnnouncedSeq модела — за topics НЯМА race риск от
        // topicMessagePollCursor-стил "изгубен ред" сценарий, защото directory
        // broadcast-ът тук е ОТДЕЛЕН от poll-а по origin: local send directno
        // broadcast-ва instant, а poll-ът напредва cursor-а само върху редове,
        // които САМ е прочел от DB — виждайки този ред по-късно той просто ще
        // пропусне instant-broadcast-натия topicId, защото rowid cursor-ът
        // вече е >= неговия rowid). Re-read на MAX(rowid) е евтина indexed
        // scalar заявка (PRIMARY KEY-driven table scan е излишен — SQLite
        // ползва rowid index directno).
        topicsDirectoryPollCursor = topicStore.getLatestActiveTopicCursor()

        // Success директно до originator-а (requestId-matched, управлява
        // popup lifecycle) + broadcast до всички ДРУГИ directory subscribers
        // (БЕЗ requestId). broadcastTopicCreatedToLocalSubscribers skip-ва
        // originator connection-а изцяло (виж коментара там) — той получава
        // ТОЧНО ЕДИН 'topic_created' пакет общо, изпратен тук.
        safeSendToConnection(connection.id, {
          type: 'topic_created',
          topic: result.topic,
          requestId,
        })
        broadcastTopicCreatedToLocalSubscribers(result.topic, { originatingConnectionId: connection.id })
        return
      }

      sendJsonMessage(socket, {
        type: 'error',
        message: 'Unsupported message type.',
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unexpected server error.'

      sendJsonMessage(socket, {
        type: 'error',
        message,
      })
    }
  })

  socket.on('close', () => {
    guestIdByConnection.delete(connection.id)
    lobbyChatSubscriberConnectionIds.delete(connection.id)
    topicsDirectorySubscriberConnectionIds.delete(connection.id)

    const disconnectedTopicId = topicMessageSubscriberTopicIdByConnectionId.get(connection.id)
    if (disconnectedTopicId !== undefined) {
      topicMessageSubscribersByTopicId.get(disconnectedTopicId)?.delete(connection.id)
      topicMessageSubscriberTopicIdByConnectionId.delete(connection.id)
    }

    try {
      if (isServerShuttingDown) {
        socketRegistry.delete(connection.id)
        return
      }

      removeConnectionFromMatchmaking(connection.id)
      privateRoomsStore.removeConnection(connection.id)

      const result = handleDisconnect(serverState, connection.id)
      const disconnectState = result.serverState

      socketRegistry.delete(connection.id)

      if (result.room === null) {
        serverState = disconnectState
        console.log(`[ws] client disconnected: ${connection.id}`)
        return
      }

      if (!shouldKeepRoomAlive(result.room)) {
        serverState = removeCommittedServerRoom(result.room.id, disconnectState)
        cleanupTempBotsFromRoom(result.room)
        markRoomSnapshotRemoved(result.room.id)
        activeRoomRuntime.removeRoom(result.room.id)
        console.log(`[room-cleanup] removed inactive room=${result.room.id}`)
        console.log(`[ws] client disconnected: ${connection.id}`)
        return
      }

      serverState = commitServerRoomWithSnapshot(result.room, disconnectState)
      broadcastRoomSnapshots(result.room, socketRegistry)
      console.log(`[ws] client disconnected: ${connection.id}`)
    } catch (error) {
      socketRegistry.delete(connection.id)
      console.error(`[ws] disconnect error: ${connection.id}`, error)
    }
  })

  socket.on('error', (error) => {
    console.error(`[ws] client error: ${connection.id}`, error)
  })
})

// ─── Game worker lifecycle ────────────────────────────────────────────────────

let gameWorkerLifecycleClient: GameWorkerLifecycleClient | null = null
let startupWorkerPingMs: number | null = null
let startupWorkerHealth: GameWorkerLifecycleHealth | null = null
let gameWorkerPool: GameWorkerPool | null = null
let gameWorkerTickOrchestrator: GameWorkerTickOrchestrator

function seedRestoredActiveRooms(): number {
  const restoredRoomIds = activeRoomRuntime.listTrackedRoomIds()

  for (const roomId of restoredRoomIds) {
    const room = serverState.rooms[roomId] ?? null

    if (room === null) {
      activeRoomRuntime.removeRoom(roomId)
      continue
    }

    const result = activeRoomRuntime.ensureRoom(room)

    if (!result.ok) {
      throw new Error(
        `[startup] Failed to assign restored room=${roomId}: ${result.reason}`,
      )
    }
  }

  return restoredRoomIds.length
}

try {
  const workerEntryUrl = await resolveGameWorkerEntryUrl()

  if (gameWorkerTickMode === 'worker-candidate') {
    gameWorkerPool = createGameWorkerPool({
      workerCount: gameWorkerPoolWorkerCount,
      maxRoomsPerWorker: gameWorkerPoolMaxRoomsPerWorker,
      workerEntryUrl,
      requestTimeoutMs: 5000,
    })

    await gameWorkerPool.start()
    activeRoomWorkerManager = createGameWorkerPoolManagerAdapter(gameWorkerPool)

    gameWorkerTickOrchestrator = createGameWorkerTickOrchestrator({
      mode: 'worker-candidate',
      revisionRegistry: roomRevisionRegistry,
      tickClient: gameWorkerPool,
    })

    const restoredRoomCount = seedRestoredActiveRooms()

    console.log(
      `[game-worker-pool] workers=${gameWorkerPoolWorkerCount} maxRoomsPerWorker=${gameWorkerPoolMaxRoomsPerWorker} seededRooms=${restoredRoomCount}`,
    )
  } else {
    gameWorkerLifecycleClient = createGameWorkerLifecycleClient({
      workerId: 'game-worker-1',
      workerEntryUrl,
      readyTimeoutMs: 5000,
      requestTimeoutMs: 5000,
    })

    await gameWorkerLifecycleClient.start()
    startupWorkerPingMs = await gameWorkerLifecycleClient.ping()
    startupWorkerHealth = await gameWorkerLifecycleClient.getHealth()

    const workerState = gameWorkerLifecycleClient.getState()

    if (workerState !== 'ready') {
      throw new Error(
        `[startup] Game worker state expected=ready got=${workerState}`,
      )
    }

    if (startupWorkerHealth.workerId !== 'game-worker-1') {
      throw new Error(
        `[startup] Game worker health workerId mismatch: expected=game-worker-1 got=${startupWorkerHealth.workerId}`,
      )
    }

    if (startupWorkerHealth.activeRooms !== 0) {
      throw new Error(
        `[startup] Game worker health activeRooms expected=0 got=${startupWorkerHealth.activeRooms}`,
      )
    }

    console.log(
      `[game-worker] workerId=${startupWorkerHealth.workerId} state=${workerState} ping=${startupWorkerPingMs}ms activeRooms=${startupWorkerHealth.activeRooms}`,
    )

    roomShadowSynchronizer = createRoomShadowSynchronizer({
      client: gameWorkerLifecycleClient,
    })

    gameWorkerTickOrchestrator = createGameWorkerTickOrchestrator({
      mode: 'in-process',
      revisionRegistry: roomRevisionRegistry,
      syncTickTarget: activeRoomRuntime,
    })

    const restoredRoomCount = seedRestoredActiveRooms()

    console.log(
      `[room-shadow-sync] created seededRooms=${restoredRoomCount}`,
    )
  }

  console.log(`[game-worker-tick] mode=${gameWorkerTickMode}`)
} catch (error) {
  console.error('[startup] Game worker lifecycle failed:', error)
  if (gameWorkerPool !== null) {
    try {
      await gameWorkerPool.shutdown()
    } catch (shutdownError) {
      console.error('[startup] Game worker pool cleanup failed:', shutdownError)
    }
  }
  if (roomShadowSynchronizer !== null) {
    try {
      await roomShadowSynchronizer.shutdown()
    } catch (shutdownError) {
      console.error('[startup] Room shadow synchronizer cleanup failed:', shutdownError)
    }
  }
  if (gameWorkerLifecycleClient !== null) {
    try {
      await gameWorkerLifecycleClient.shutdown()
    } catch (shutdownError) {
      console.error('[startup] Game worker lifecycle cleanup failed:', shutdownError)
    }
  }
  closeActiveRoomSnapshotStore()
  throw error
}

// ─── Matchmaking and game tick intervals ──────────────────────────────────────

const matchmakingTickInterval = setInterval(() => {
  if (isServerShuttingDown) {
    return
  }

  backgroundJobMetrics.recordSync('matchmakingTick', processMatchmaking)
}, MATCHMAKING_TICK_MS)

const gameRuntimeTickInterval = setInterval(() => {
  if (isServerShuttingDown) {
    return
  }

  void backgroundJobMetrics
    .recordAsync('gameRuntimeTick', tickRoomGameRuntimes)
    .catch((error) => {
      const safeErrorMessage =
        error instanceof Error ? error.message : String(error)
      console.error('[game-worker-tick] Tick loop failed.', safeErrorMessage)
    })
}, GAME_RUNTIME_TICK_MS)

// Само в strictly local tournament test mode (виж localTournamentTestModeGuard.ts) —
// по-чест poll tick, за да не удвои изчакването наложено от вече ускорените
// attendance/transition таймери (tournamentCoordinator.ts). Без флага е
// undefined и двата store-а падат обратно на production DEFAULT_INTERVAL_MS.
const localTournamentTestPollIntervalMs = isLocalTournamentTestModeEnabled() ? 1_000 : undefined

try {
  tournamentScheduler = await createTournamentScheduler({
    databaseFilePath: databaseBootstrap.databaseFilePath,
    economyStore: tournamentEconomyStore,
    intervalMs: localTournamentTestPollIntervalMs,
    logError: (message, error) => console.error(message, sanitizeErrorMessage(error)),
    // §"ONLINE USER"/"OFFLINE USER"/"EXACTLY ONCE" в task spec-а за
    // auto-cancel известието — durable ред-ът вече е committed вътре в
    // autoCancelScheduledTournamentAtomically (виж tournament_economy_notice_log).
    // Тук само доставяме: online connections получават push веднага И се
    // маркират delivered (за да не се доставят повторно при следващ login);
    // offline recipients остават delivered_at=NULL до следващия им
    // login/reconnect (виж flush блока при connection setup).
    notifyEconomyRefunds: (tournamentId, reason, refundedProfiles) => {
      for (const { profileId, amount, noticeId } of refundedProfiles) {
        const sentCount = sendToOpenProfileConnections(profileId, {
          type: 'tournament_economy_notice',
          eventId: randomUUID(),
          tournamentId,
          reason,
          amount,
          occurredAt: new Date().toISOString(),
        })
        if (sentCount > 0) {
          tournamentEconomyStore.markTournamentEconomyNoticeDelivered(noticeId, profileId)
        }
      }
    },
    onTickTiming: (durationMs) => backgroundJobMetrics.record('tournamentSchedulerTick', durationMs),
  })
  tournamentScheduler.start()
  console.log('[tournament-scheduler] Scheduler started')
} catch (error) {
  console.error('[tournament-scheduler] Failed to start scheduler:', sanitizeErrorMessage(error))
}

try {
  tournamentCoordinator = await createTournamentCoordinator({
    databaseFilePath: databaseBootstrap.databaseFilePath,
    intervalMs: localTournamentTestPollIntervalMs,
    getPublicProfile: (profileId) => playerProgressStore.getPublicProfile(profileId),
    getRoom: (roomId) => serverState.rooms[roomId] ?? null,
    commitRoom: (room) => {
      serverState = commitServerRoomWithSnapshot(room)
      broadcastRoomSnapshots(room, socketRegistry)
    },
    // Извиква се веднага след commitRoom(finishedRoom) при completed турнирен
    // мач (walkover или нормално изигран) — премахва runtime стаята
    // ДЕТЕРМИНИРАНО и НЕЗАБАВНО, вместо да разчита на обичайния
    // shouldKeepRoomAlive/TTL reap loop (виж tickRoomGameRuntimes), който би
    // задържал стаята жива, докато печелившият отбор е все още свързан.
    // Огледало на cleanupInactiveRoomIfNeeded-ото force-remove разклонение;
    // споделя точно същото тяло с forceRemoveTournamentRoomById по-горе.
    closeCompletedRoom: (room) => {
      forceRemoveTournamentRoomById(room.id)
    },
    ensureRoomRuntime: (room) => activeRoomRuntime.ensureRoom(room),
    settleTournamentPrizes: (tournamentId) => {
      return tournamentEconomyStore.settleTournamentPrizesAtomically(tournamentId, new Date())
    },
    isConnectionAttached: ({ profileId, connectionId, roomId, seat }) => {
      const connection = serverState.connections[connectionId] ?? null
      return (
        connection !== null &&
        connection.status === 'connected' &&
        connection.profileId === profileId &&
        connection.currentRoomId === roomId &&
        connection.currentSeat === seat
      )
    },
    // Project-wide "профилът има поне една отворена автентикирана WS връзка"
    // (§"PRESENCE SEMANTICS" в task spec-а) — reuse на същия socket-readiness
    // pattern като /api/players листинга по-долу (Set-building за online
    // статус), НЕ room/seat-scoped isConnectionAttached по-горе. Multi-tab:
    // достатъчна е поне ЕДНА отворена връзка за профила.
    isProfileOnline: (profileId) => {
      for (const connection of Object.values(serverState.connections)) {
        if (
          connection.profileId === profileId &&
          socketRegistry.get(connection.id)?.readyState === WebSocket.OPEN
        ) {
          return true
        }
      }
      return false
    },
    notifyAssignment: (profileId, assignment) => {
      sendTournamentMatchAssignment(profileId, assignment)
    },
    notifyFeederMatchCompleted: (profileIds, update) => {
      for (const profileId of profileIds) {
        sendToOpenProfileConnections(profileId, {
          type: 'tournament_feeder_match_completed',
          ...update,
        })
      }
    },
    notifyFeederScoreProgress: (profileIds, update) => {
      for (const profileId of profileIds) {
        sendToOpenProfileConnections(profileId, {
          type: 'tournament_feeder_score_progress',
          ...update,
        })
      }
    },
    logError: (message, error) => console.error(message, sanitizeErrorMessage(error)),
    onRoundStarted: () => {
      activityCounters.incrementTournament('tournamentRoundStart')
    },
    onMatchResult: () => {
      activityCounters.incrementTournament('tournamentMatchResult')
    },
    onTickTiming: (durationMs) => backgroundJobMetrics.record('tournamentCoordinatorTick', durationMs),
  })
  tournamentCoordinator.start()
  console.log('[tournament-coordinator] Coordinator started')
} catch (error) {
  console.error('[tournament-coordinator] Failed to start coordinator:', sanitizeErrorMessage(error))
}

// ─── Monitoring sampler ───────────────────────────────────────────────────────

try {
  monitoringSampler = createMonitoringSampler({
    backendStartedAtMs,
    getWsConnectionCount: () => countOpenWebSockets(socketRegistry),
    getUniqueOnlineRealPlayers: () => countUniqueOnlineRealPlayers(serverState.connections),
    getMatchmakingWaitersByStake: () => getQueueCountsByStake(),
    getActiveRoomCount: () => Object.keys(serverState.rooms).length,
    getRoomsByPhase: () => countServerRoomsByPhase(serverState.rooms),
    getActiveRooms: () =>
      computeActiveRoomsSnapshot(serverState.rooms, (roomId) =>
        gameWorkerPool?.getWorkerIdForRoom(roomId) ?? null,
      ),
    getWorkerPoolHealth: () => gameWorkerPool?.getHealth() ?? null,
    getWorkerCpuUsages: () => gameWorkerPool?.getWorkerCpuUsages() ?? Promise.resolve([]),
    sampleEventLoopHealth: () => eventLoopMonitor.sample(),
  })
  console.log('[monitoring] Sampler started')
} catch (error) {
  console.error('[monitoring] Failed to start sampler:', sanitizeErrorMessage(error))
}

// ─── Monitoring history ───────────────────────────────────────────────────────

try {
  monitoringHistoryStore = await createMonitoringHistoryStore(databaseBootstrap.databaseFilePath)
  console.log('[monitoring] History store ready')

  monitoringHistoryStore.purgeOlderThan(getDefaultRetentionCutoffMs())

  monitoringHistoryIntervalId = setInterval(() => {
    if (monitoringSampler === null || monitoringHistoryStore === null) return
    backgroundJobMetrics.recordSync('monitoringHistoryPersist', () => {
      monitoringHistoryStore?.record(monitoringSampler!.getSnapshot())
    })
  }, 60_000)

  monitoringHistoryPurgeIntervalId = setInterval(() => {
    backgroundJobMetrics.recordSync('monitoringHistoryPurge', () => {
      monitoringHistoryStore?.purgeOlderThan(getDefaultRetentionCutoffMs())
    })
  }, 60 * 60 * 1000)

  console.log('[monitoring] History recording started (60s interval, 30d retention)')
} catch (error) {
  console.error('[monitoring] Failed to start history store:', sanitizeErrorMessage(error))
}

// ─── CPU incident forensics ─────────────────────────────────────────────────
//
// Отделен слой от monitoring_history — не пипа 1h/24h/7d dashboard-а.
// 1s CPU семпли (reuse на вече-семплирания monitoringSampler snapshot, не нов
// os/process syscall loop) → EXTREME SPIKE detector (веднага) + 10s bucket
// accumulator → SUSTAINED HIGH state machine + ring buffer (5 мин) → persist
// само при реален затворен incident.

try {
  cpuIncidentStore = await createCpuIncidentStore(databaseBootstrap.databaseFilePath)
  console.log('[monitoring] CPU incident store ready')

  cpuIncidentStore.purgeOlderThan(getDefaultSummaryRetentionCutoffMs(), getDefaultTimelineRetentionCutoffMs())

  cpuForensicSampleIntervalId = setInterval(() => {
    if (monitoringSampler === null) return
    const snap = monitoringSampler.getSnapshot()

    // TEMPORAL ALIGNMENT (виж final fix pass брифа §5) — completed
    // one-second forensic snapshot-и се вземат ВИНАГИ, на всеки 1s tick,
    // независимо дали текущият CPU sample е spike или не. Това е
    // единственият начин двата dual-window accumulator-а (activity,
    // backgroundJobMetrics, gcMetrics) да останат coherent — ако вземахме
    // snapshotOneSecondAndReset() само when CPU>=threshold, събитията от
    // "тихите" секунди между два spike-а щяха да се натрупат в
    // oneSecond прозореца и погрешно да се припишат на следващия spike.
    // Извикват се непосредствено СЛЕД четенето на CPU snapshot-а — най-
    // близкото практически достижимо подравняване в рамките на Node
    // event-loop timer ordering (виж SpikeContext коментара в
    // cpuIncidentTypes.ts за пълната temporal alignment семантика и
    // документираната максимална skew).
    const oneSecondActivity = activityCounters.snapshotOneSecondAndReset()
    const oneSecondBackgroundJobs = backgroundJobMetrics.snapshotOneSecondAndReset()
    const oneSecondGc = gcMetrics.snapshotOneSecondAndReset()

    if (snap.processCpuNowPercent === null) return

    // Diagnostic fix (виж forensic audit §1) — само при EXTREME SPIKE прага
    // снемаме пълния forensic context (online/active matches/ws са O(n) —
    // затова НЕ се смятат на всяка секунда, само когато spike-ът реално е
    // детектиран). activity/backgroundJobs/gc обаче ВИНАГИ се вземат от
    // completed one-second snapshot-а по-горе — reset-ват се на всеки tick,
    // независимо дали spike има или не, за да пазим dual-window инварианта.
    const context: SpikeContext | null =
      snap.processCpuNowPercent >= CPU_INCIDENT_THRESHOLDS.extremeSpikePercent
        ? {
            serverCpuPercent: snap.serverCpuNowPercent,
            gameWorkerCpuPercent: snap.gameWorkerCpuNowPercent,
            nonGameWorkerProcessCpuPercent: snap.nonGameWorkerProcessCpuNowPercent,
            // Worker CPU staleness (виж final fix pass брифа §9) — age спрямо
            // ТОЗИ spike sample-ов timestamp, не спрямо wall-clock "сега".
            gameWorkerCpuSampleAgeMs:
              snap.gameWorkerCpuSampledAtMs !== null
                ? Math.max(0, snap.sampledAtMs - snap.gameWorkerCpuSampledAtMs)
                : null,
            nonGameWorkerProcessCpuSampleAgeMs:
              snap.gameWorkerCpuSampledAtMs !== null
                ? Math.max(0, snap.sampledAtMs - snap.gameWorkerCpuSampledAtMs)
                : null,
            eventLoopUtilization: snap.eventLoopUtilization,
            eventLoopDelayP99Ms: snap.eventLoopDelayP99Ms,
            rssMb: snap.processRssMb,
            heapUsedMb: snap.processHeapUsedMb,
            onlinePlayers: countUniqueOnlineRealPlayers(serverState.connections),
            activeMatches: Object.keys(serverState.rooms).length,
            wsConnections: countOpenWebSockets(socketRegistry),
            matchmakingWaiters: Object.values(getQueueCountsByStake()).reduce((s, n) => s + n, 0),
            activity: oneSecondActivity,
            backgroundJobs: oneSecondBackgroundJobs,
            gc: oneSecondGc,
          }
        : null

    cpuIncidentDetector.observeCpuSample(
      { sampledAtMs: snap.sampledAtMs, processCpuPercent: snap.processCpuNowPercent, context },
      cpuForensicRingBuffer.toArray(),
    )

    cpuBucketAccumulator.addSample({
      atMs: snap.sampledAtMs,
      processCpu: snap.processCpuNowPercent,
      serverCpu: snap.serverCpuNowPercent,
      gameWorkerCpu: snap.gameWorkerCpuNowPercent,
      nonGameWorkerProcessCpu: snap.nonGameWorkerProcessCpuNowPercent,
      eventLoopUtilization: snap.eventLoopUtilization,
      eventLoopDelayP50Ms: snap.eventLoopDelayP50Ms,
      eventLoopDelayP99Ms: snap.eventLoopDelayP99Ms,
      rssMb: snap.processRssMb,
      heapUsedMb: snap.processHeapUsedMb,
    })
  }, 1_000)

  cpuForensicBucketIntervalId = setInterval(() => {
    const bucketStartMs = Date.now()
    const bucket = cpuBucketAccumulator.flush(bucketStartMs, {
      onlinePlayers: countUniqueOnlineRealPlayers(serverState.connections),
      activeMatches: Object.keys(serverState.rooms).length,
      wsConnections: countOpenWebSockets(socketRegistry),
      matchmakingWaiters: Object.values(getQueueCountsByStake()).reduce((s, n) => s + n, 0),
      activity: activityCounters.snapshotTenSecondAndReset(),
      backgroundJobs: backgroundJobMetrics.snapshotTenSecondAndReset(),
      gc: gcMetrics.snapshotTenSecondAndReset(),
    })

    cpuForensicRingBuffer.push(bucket)
    cpuIncidentDetector.observeBucket(bucket, cpuForensicRingBuffer.toArray())

    const closedIncidents = cpuIncidentDetector.drainClosedIncidents()
    for (const incident of closedIncidents) {
      try {
        cpuIncidentStore?.persistIncident(incident)
      } catch (error) {
        console.error('[monitoring] Failed to persist CPU incident:', sanitizeErrorMessage(error))
      }
    }
  }, CPU_INCIDENT_SAMPLING.bucketMs)

  cpuIncidentPurgeIntervalId = setInterval(() => {
    cpuIncidentStore?.purgeOlderThan(getDefaultSummaryRetentionCutoffMs(), getDefaultTimelineRetentionCutoffMs())
  }, 60 * 60 * 1000)

  console.log('[monitoring] CPU incident forensics started (1s sample, 10s bucket, 90d/14d retention)')
} catch (error) {
  console.error('[monitoring] Failed to start CPU incident forensics:', sanitizeErrorMessage(error))
}

function clearMutationTimersForShutdown(): void {
  clearInterval(gameRuntimeTickInterval)
  clearInterval(matchmakingTickInterval)

  if (catalogBotRefillInterval !== null) {
    clearInterval(catalogBotRefillInterval)
    catalogBotRefillInterval = null
  }

  if (supportCleanupInterval !== null) {
    clearInterval(supportCleanupInterval)
    supportCleanupInterval = null
  }

  if (siteVisitRetentionInterval !== null) {
    clearInterval(siteVisitRetentionInterval)
    siteVisitRetentionInterval = null
  }

  if (siteVisitRetentionStartupTimeout !== null) {
    clearTimeout(siteVisitRetentionStartupTimeout)
    siteVisitRetentionStartupTimeout = null
  }

  if (missionRotationTimeout !== null) {
    clearTimeout(missionRotationTimeout)
    missionRotationTimeout = null
  }

  if (lobbyChatPollInterval !== null) {
    clearInterval(lobbyChatPollInterval)
    lobbyChatPollInterval = null
  }

  if (topicMessagePollInterval !== null) {
    clearInterval(topicMessagePollInterval)
    topicMessagePollInterval = null
  }

  if (topicMessageLikePollInterval !== null) {
    clearInterval(topicMessageLikePollInterval)
    topicMessageLikePollInterval = null
  }

  if (topicsDirectoryPollInterval !== null) {
    clearInterval(topicsDirectoryPollInterval)
    topicsDirectoryPollInterval = null
  }

  if (lobbyChatRetentionInterval !== null) {
    clearInterval(lobbyChatRetentionInterval)
    lobbyChatRetentionInterval = null
  }

  if (lobbyChatRetentionStartupTimeout !== null) {
    clearTimeout(lobbyChatRetentionStartupTimeout)
    lobbyChatRetentionStartupTimeout = null
  }

  if (chatAttachmentCleanupInterval !== null) {
    clearInterval(chatAttachmentCleanupInterval)
    chatAttachmentCleanupInterval = null
  }

  if (chatAttachmentCleanupStartupTimeout !== null) {
    clearTimeout(chatAttachmentCleanupStartupTimeout)
    chatAttachmentCleanupStartupTimeout = null
  }

  if (chatAttachmentOrphanScanInterval !== null) {
    clearInterval(chatAttachmentOrphanScanInterval)
    chatAttachmentOrphanScanInterval = null
  }

  if (chatAttachmentOrphanScanStartupTimeout !== null) {
    clearTimeout(chatAttachmentOrphanScanStartupTimeout)
    chatAttachmentOrphanScanStartupTimeout = null
  }

  if (supportAttachmentCleanupInterval !== null) {
    clearInterval(supportAttachmentCleanupInterval)
    supportAttachmentCleanupInterval = null
  }

  if (supportAttachmentCleanupStartupTimeout !== null) {
    clearTimeout(supportAttachmentCleanupStartupTimeout)
    supportAttachmentCleanupStartupTimeout = null
  }

  if (supportAttachmentOrphanScanInterval !== null) {
    clearInterval(supportAttachmentOrphanScanInterval)
    supportAttachmentOrphanScanInterval = null
  }

  if (supportAttachmentOrphanScanStartupTimeout !== null) {
    clearTimeout(supportAttachmentOrphanScanStartupTimeout)
    supportAttachmentOrphanScanStartupTimeout = null
  }

  if (topicAttachmentCleanupInterval !== null) {
    clearInterval(topicAttachmentCleanupInterval)
    topicAttachmentCleanupInterval = null
  }

  if (topicAttachmentCleanupStartupTimeout !== null) {
    clearTimeout(topicAttachmentCleanupStartupTimeout)
    topicAttachmentCleanupStartupTimeout = null
  }

  if (topicRetentionPurgeInterval !== null) {
    clearInterval(topicRetentionPurgeInterval)
    topicRetentionPurgeInterval = null
  }

  if (topicRetentionPurgeStartupTimeout !== null) {
    clearTimeout(topicRetentionPurgeStartupTimeout)
    topicRetentionPurgeStartupTimeout = null
  }

  if (topicAttachmentOrphanScanInterval !== null) {
    clearInterval(topicAttachmentOrphanScanInterval)
    topicAttachmentOrphanScanInterval = null
  }

  if (topicAttachmentOrphanScanStartupTimeout !== null) {
    clearTimeout(topicAttachmentOrphanScanStartupTimeout)
    topicAttachmentOrphanScanStartupTimeout = null
  }

  clearPrivateRoomInviteTimers()
  tournamentScheduler?.stop()
  tournamentCoordinator?.stop()
  monitoringSampler?.stop()
  monitoringSampler = null

  if (monitoringHistoryIntervalId !== null) {
    clearInterval(monitoringHistoryIntervalId)
    monitoringHistoryIntervalId = null
  }

  if (monitoringHistoryPurgeIntervalId !== null) {
    clearInterval(monitoringHistoryPurgeIntervalId)
    monitoringHistoryPurgeIntervalId = null
  }

  if (cpuForensicSampleIntervalId !== null) {
    clearInterval(cpuForensicSampleIntervalId)
    cpuForensicSampleIntervalId = null
  }

  if (cpuForensicBucketIntervalId !== null) {
    clearInterval(cpuForensicBucketIntervalId)
    cpuForensicBucketIntervalId = null
  }

  if (cpuIncidentPurgeIntervalId !== null) {
    clearInterval(cpuIncidentPurgeIntervalId)
    cpuIncidentPurgeIntervalId = null
  }

  eventLoopMonitor.stop()
  gcMetrics.stop()
}

function closeActiveRoomSnapshotStore(): boolean {
  let allClosedSuccessfully = true

  function closeStore(name: string, close: () => void): void {
    try {
      close()
    } catch (error) {
      allClosedSuccessfully = false
      console.error(`[shutdown] Failed to close ${name}:`, error)
    }
  }

  closeStore('activeRoomSnapshotStore', () => activeRoomSnapshotStore.close())
  closeStore('playerProgressStore', () => playerProgressStore.close())
  closeStore('adminSettingsStore', () => adminSettingsStore.close())
  closeStore('authStore', () => authStore.close())
  closeStore('friendshipStore', () => friendshipStore.close())
  closeStore('chatStore', () => chatStore.close())
  closeStore('lobbyChatStore', () => lobbyChatStore.close())
  closeStore('yellowCoinGiftStore', () => yellowCoinGiftStore.close())
  closeStore('tableExitPenaltyStore', () => tableExitPenaltyStore.close())
  closeStore('matchEconomyStore', () => matchEconomyStore.close())
  closeStore('coinPackageStore', () => coinPackageStore.close())
  closeStore('coinPurchaseStore', () => coinPurchaseStore.close())
  closeStore('dailyRewardsStore', () => dailyRewardsStore.close())
  closeStore('siteVisitStore', () => siteVisitStore.close())
  closeStore('tournamentAdminStore', () => tournamentAdminStore.close())
  closeStore('tournamentScheduler', () => tournamentScheduler?.close())
  tournamentScheduler = null
  closeStore('tournamentCoordinator', () => tournamentCoordinator?.close())
  tournamentCoordinator = null

  if (passwordResetStore !== null) {
    closeStore('passwordResetStore', () => passwordResetStore!.close())
    passwordResetStore = null
  }

  if (monitoringHistoryStore !== null) {
    closeStore('monitoringHistoryStore', () => monitoringHistoryStore!.close())
    monitoringHistoryStore = null
  }

  return allClosedSuccessfully
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let serverShutdownPromise: Promise<void> | null = null

function shutdownServer(signal: NodeJS.Signals): Promise<void> {
  if (serverShutdownPromise !== null) {
    return serverShutdownPromise
  }

  serverShutdownPromise = (async () => {
    console.log(`[shutdown] signal=${signal}`)

    let exitCode = 0
    isServerShuttingDown = true

    try {
      wsServer.close((error) => {
        if (error) {
          console.error('[shutdown] WebSocket server close error:', error)
        }
      })
    } catch (error) {
      console.error('[shutdown] WebSocket server close error:', error)
      exitCode = 1
    }

    try {
      httpServer.close((error) => {
        if (error) {
          console.error('[shutdown] HTTP server close error:', error)
        }
      })
    } catch (error) {
      console.error('[shutdown] HTTP server close error:', error)
      exitCode = 1
    }

    clearMutationTimersForShutdown()

    try {
      await gameWorkerTickOrchestrator.shutdown()
    } catch (error) {
      console.error('[shutdown] Game worker tick orchestrator shutdown error:', error)
      exitCode = 1
    }

    if (gameWorkerPool !== null) {
      try {
        await gameWorkerPool.shutdown()
      } catch (error) {
        console.error('[shutdown] Game worker pool shutdown error:', error)
        exitCode = 1
      }
    }

    if (roomShadowSynchronizer !== null) {
      try {
        await roomShadowSynchronizer.shutdown()
      } catch (error) {
        console.error('[shutdown] Room shadow synchronizer shutdown error:', error)
        exitCode = 1
      }
    }

    if (gameWorkerLifecycleClient !== null) {
      try {
        await gameWorkerLifecycleClient.shutdown()

        const finalState = gameWorkerLifecycleClient.getState()

        if (finalState !== 'stopped') {
          console.error(
            `[shutdown] Game worker final state expected=stopped got=${finalState}`,
          )
          exitCode = 1
        }
      } catch (error) {
        console.error('[shutdown] Game worker shutdown error:', error)
        exitCode = 1
      }
    }

    const storesClosedSuccessfully = closeActiveRoomSnapshotStore()

    if (!storesClosedSuccessfully) {
      exitCode = 1
    }

    try {
      await trainingRecorder.shutdown(3_000)
    } catch (error) {
      console.error('[shutdown] Training recorder shutdown error:', error)
    }

    process.exit(exitCode)
  })()

  return serverShutdownPromise
}

process.once('SIGINT', () => {
  void shutdownServer('SIGINT')
})

process.once('SIGTERM', () => {
  void shutdownServer('SIGTERM')
})

httpServer.listen(PORT, HOST, () => {
  console.log(`[http] Belot V2 server is running at http://${HOST}:${PORT}`)
  console.log(`[ws] WebSocket endpoint is ws://localhost:${PORT}/ws`)
  console.log('[http] Health check: /health')
  console.log(
    `[matchmaking] stakes=${SUPPORTED_MATCH_STAKES.join(', ')} | wait=${MATCHMAKING_WAIT_MS}ms`,
  )
  console.log(
    `[game-runtime] passive hook enabled | tick=${GAME_RUNTIME_TICK_MS}ms`,
  )
})
