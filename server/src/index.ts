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
import { createAdminSettingsStore } from './db/adminSettingsStore.js'
import {
  createAuthStore,
  createClearSessionCookieHeader,
  createSessionCookieHeader,
  getSessionTokenFromCookieHeader,
  isAdminOrSubadminSession,
  isFullAdminSession,
  isLobbyChatModeratorSession,
  type AuthSessionSnapshot,
} from './db/authStore.js'
import { createChatStore } from './db/chatStore.js'
import { createLobbyChatStore } from './db/lobbyChatStore.js'
import {
  validateLobbyChatBody,
  countUnicodeCodePoints,
  LOBBY_CHAT_MAX_BODY_CODE_POINTS,
} from './protocol/lobbyChatValidation.js'
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
import { createCoinPurchaseStore, ADMIN_PAYMENT_PERIODS } from './db/coinPurchaseStore.js'
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
import {
  TOURNAMENT_STATUSES,
  type TournamentPartnerInviteRecord,
  type TournamentRecord,
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
import { normalizeProfileSearchTerm } from './db/normalizeProfileIdentityText.js'
import {
  computePlayersPageOrder,
  generatePlayersPageSeed,
} from './db/computePlayersPageOrder.js'
import { createPlayersPageSnapshotStore } from './db/playersPageSnapshotStore.js'
import { createPlayerProgressStore } from './db/playerProgressStore.js'
import { createTableExitPenaltyStore } from './db/tableExitPenaltyStore.js'
import { createYellowCoinGiftStore } from './db/yellowCoinGiftStore.js'
import { attachConnectionToRoomSeat } from './core/attachConnectionToRoomSeat.js'
import { broadcastRoomSnapshots } from './core/broadcastRoomSnapshots.js'
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
import type { LobbyChatErrorCode, PrivateRoomChatErrorCode } from './protocol/messageTypes.js'
import { createPrivateRoomsStore } from './game/privateRoomsStore.js'
import type { PrivateRoom, PrivateRoomMember } from './game/privateRoomsStore.js'
import { createPrivateRoomChatStore, PRIVATE_ROOM_CHAT_HISTORY_LIMIT } from './game/privateRoomChatStore.js'
import { addHumanToRoom } from './core/addHumanToRoom.js'
import { createRoomWithHumanHost } from './core/createRoomWithHumanHost.js'
import { createGuestTrialRoom } from './core/createGuestTrialRoom.js'
import { createServerRoom } from './core/createServerRoom.js'
import { createHumanParticipant } from './core/createHumanParticipant.js'
import { createBotParticipant } from './core/createBotParticipant.js'
import { seatParticipantInRoom } from './core/seatParticipantInRoom.js'
import { updateRoomHostPlayerId } from './core/updateRoomHostPlayerId.js'
import { shuffleSeatOrder } from './core/seededRandom.js'
import type { ClientMessage, PrivateRoomSnapshot } from './protocol/messageTypes.js'
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
import { resumeCoinPurchaseCheckout } from './shop/resumeCoinPurchaseCheckout.js'
import { hideCoinPurchase } from './shop/hideCoinPurchase.js'
import { createTrainingRecorder } from './trainingRecorder/trainingRecorder.js'
import {
  handleTrainingRecorderOnApplied,
  handleTrainingRecorderHumanBid,
  handleTrainingRecorderHumanCard,
} from './trainingRecorder/trainingRecorderHooks.js'
import type { TrainingRecorderMetrics } from './trainingRecorder/trainingRecorderMetrics.js'

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
    case 'fill_private_room_with_bots':
    case 'subscribe_private_room_chat':
    case 'unsubscribe_private_room_chat':
    case 'send_private_room_chat_message':
    case 'subscribe_lobby_chat':
    case 'unsubscribe_lobby_chat':
    case 'send_lobby_chat_message':
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

const databaseBootstrap = await ensureServerDatabaseReady()
const botCatalogImport = await importBotProfilesCatalog(
  databaseBootstrap.databaseFilePath,
)
const activeRoomSnapshotStore = await createActiveRoomSnapshotStore(
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
)
const lobbyChatStore = await createLobbyChatStore(databaseBootstrap.databaseFilePath)

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
)
const tableExitPenaltyStore = await createTableExitPenaltyStore(
  databaseBootstrap.databaseFilePath,
  playerProgressStore,
)
const matchRoomsStore = await createMatchRoomsStore(databaseBootstrap.databaseFilePath)
setSupportedMatchStakes(matchRoomsStore.getEnabledStakes())
setMatchPrizeResolver((stake) => matchRoomsStore.getPrizeAmount(stake))

const matchEconomyStore = await createMatchEconomyStore(databaseBootstrap.databaseFilePath)
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
    members: room.members.map((m) => ({
      profileId: m.profileId,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      level: m.level,
      rankTitle: m.rankTitle,
      isHost: m.connectionId === room.hostConnectionId,
    })),
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
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
  for (const member of room.members) {
    safeSendToConnection(member.connectionId, { type: 'private_room_updated', room: snapshot })
  }
}

// PrivateRoomMember.connectionId е снапшот, взет в момента на join/create и
// може вече да е мъртъв (WS reconnect на мобилна мрежа създава нов
// connection.id, но старият остава в room.members до следващия
// reconnectMember() — виж коментара в privateRoomsStore.ts). Затова тук
// НИКОГА не подаваме member.connectionId directно на createHumanParticipant/
// attachConnectionToRoomSeat — първо намираме реално жива връзка:
//  1) ако member.connectionId все още е 'connected' И socket-ът е OPEN,
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
  member: PrivateRoomMember,
): ConnectionId | null {
  const storedConn = getConnectionById(state, member.connectionId)
  const storedSocket = socketRegistry.get(member.connectionId)
  if (storedConn?.status === 'connected' && storedSocket?.readyState === WebSocket.OPEN) {
    return member.connectionId
  }

  if (member.profileId === null) {
    return null
  }

  for (const candidate of Object.values(state.connections)) {
    if (candidate.profileId !== member.profileId || candidate.status !== 'connected') {
      continue
    }
    const candidateSocket = socketRegistry.get(candidate.id)
    if (candidateSocket?.readyState === WebSocket.OPEN) {
      return candidate.id
    }
  }

  return null
}

function handlePrivateRoomFull(privateRoom: PrivateRoom): void {
  const [hostMember, ...restMembers] = privateRoom.members

  const hostPublicProfile = hostMember.profileId
    ? playerProgressStore.getPublicProfile(hostMember.profileId)
    : null

  const hostLiveConnectionId = resolveLiveConnectionForMember(serverState, hostMember)

  const roomResult = createRoomWithHumanHost({
    connectionId: hostLiveConnectionId,
    identity: {
      profileId: hostMember.profileId,
      displayName: hostMember.displayName,
      avatarUrl: hostMember.avatarUrl,
      level: hostMember.level,
      rankTitle: hostMember.rankTitle,
    },
    publicProfile: hostPublicProfile,
    config: {
      allowBots: false,
      isPrivate: true,
      isPrivateTableOrigin: true,
      stakeAmount: privateRoom.stake,
    },
  })

  let currentRoom = roomResult.room
  let nextServerState = upsertServerRoom(serverState, currentRoom)

  const seatAssignments: Array<{ connectionId: string; seat: Seat }> = []
  const liveConnectionIdsForExpiryNotice: string[] = []
  if (hostLiveConnectionId !== null) {
    liveConnectionIdsForExpiryNotice.push(hostLiveConnectionId)
  }

  if (hostLiveConnectionId !== null) {
    const hostConn = getConnectionById(nextServerState, hostLiveConnectionId)
    if (hostConn) {
      const nextHostConn = attachConnectionToRoomSeat(hostConn, hostLiveConnectionId, currentRoom, roomResult.seat)
      nextServerState = updateServerConnectionInState(nextServerState, hostLiveConnectionId, nextHostConn)
      seatAssignments.push({ connectionId: hostLiveConnectionId, seat: roomResult.seat })
    }
  }

  for (const member of restMembers) {
    const publicProfile = member.profileId
      ? playerProgressStore.getPublicProfile(member.profileId)
      : null

    const memberLiveConnectionId = resolveLiveConnectionForMember(nextServerState, member)
    if (memberLiveConnectionId !== null) {
      liveConnectionIdsForExpiryNotice.push(memberLiveConnectionId)
    }

    const addResult = addHumanToRoom(currentRoom, {
      connectionId: memberLiveConnectionId,
      identity: {
        profileId: member.profileId,
        displayName: member.displayName,
        avatarUrl: member.avatarUrl,
        level: member.level,
        rankTitle: member.rankTitle,
      },
      publicProfile,
    })

    currentRoom = addResult.room
    nextServerState = updateServerRoomInState(nextServerState, currentRoom.id, currentRoom)

    if (memberLiveConnectionId !== null) {
      const memberConn = getConnectionById(nextServerState, memberLiveConnectionId)
      if (memberConn) {
        const nextMemberConn = attachConnectionToRoomSeat(memberConn, memberLiveConnectionId, currentRoom, addResult.seat)
        nextServerState = updateServerConnectionInState(nextServerState, memberLiveConnectionId, nextMemberConn)
        seatAssignments.push({ connectionId: memberLiveConnectionId, seat: addResult.seat })
      }
    }
  }

  const initializedRoom = initializeRoomAuthoritativeGameState(currentRoom)

  function notifyMembersExpired(): void {
    // Известява живите (resolved) връзки — не суровите privateRoom.members,
    // които може вече да сочат към мъртъв connectionId (виж
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
    return
  }

  if (privateRoom.stake > 0) {
    const stakeResult = matchEconomyStore.collectRoomStakes(initializedRoom, privateRoom.stake)
    if (!stakeResult.ok) {
      console.error(`[private-room] stake collection failed room=${initializedRoom.id}: ${stakeResult.message}`)
      activeRoomRuntime.removeRoom(initializedRoom.id)
      notifyMembersExpired()
      return
    }
  }

  nextServerState = commitServerRoomWithSnapshot(initializedRoom, nextServerState)
  serverState = nextServerState

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
  for (const member of room.members) {
    safeSendToConnection(member.connectionId, {
      type: 'private_room_expired',
      privateRoomId: room.id,
    })
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
  for (const member of room.members) {
    if (member.connectionId !== room.hostConnectionId) {
      safeSendToConnection(member.connectionId, {
        type: 'private_room_closed',
        privateRoomId: room.id,
      })
    }
  }
}

function handlePrivateRoomMemberLeft(room: PrivateRoom, member: PrivateRoomMember): void {
  safeSendToConnection(room.hostConnectionId, {
    type: 'private_room_member_left',
    displayName: member.displayName,
  })
}

// "Запълни с ботове" — вика се от privateRoomsStore.beginBotFill(), който
// вече е откачил синхронно `privateRoom` от store-а (виж коментара там),
// така че нищо конкурентно не може повече да го присъедини/промени. Огледало
// на handlePrivateRoomFull, но с два разлики: (1) местата на хората и
// ботовете се разбъркват еднократно на сървъра (SERVER_TEAM_A/B съставите не
// се пазят от реда на присъединяване), (2) допълва оставащите места с ботове
// през същия matchmaking bot-selection механизъм (без паралелен gameplay поток).
function handlePrivateRoomBotFill(privateRoom: PrivateRoom): void {
  const botsNeeded = 4 - privateRoom.members.length

  const selectedBotProfiles = selectMatchmakingBotProfiles({
    stake: privateRoom.stake,
    count: botsNeeded,
    selectionSeed: `private-room-fill:${privateRoom.id}`,
    createTempBot: (stake, profileId, baseName, completedGamesCount, wonGamesCount) => {
      const stakeMinLevel = matchRoomsStore.getRoom(stake)?.minLevel ?? 1
      if (stakeMinLevel > 7) return null
      const profile = playerProgressStore.createTemporaryBotProfile(profileId, baseName, completedGamesCount, wonGamesCount)
      return profile.displayName
    },
  })

  if (selectedBotProfiles.length < botsNeeded) {
    console.error(
      `[private-room] bot-fill could not select enough bots room=${privateRoom.id}: needed=${botsNeeded} got=${selectedBotProfiles.length}`,
    )
    for (const member of privateRoom.members) {
      safeSendToConnection(member.connectionId, {
        type: 'private_room_expired',
        privateRoomId: privateRoom.id,
      })
    }
    privateRoomChatStore.clearRoom(privateRoom.id)
    return
  }

  // Единствената random стъпка — извиква се точно веднъж, тук, при
  // окончателното стартиране. Резултатът се материализира директно в
  // room.seats (server-authoritative), не се преизчислява при reconnect.
  const shuffledSeats = shuffleSeatOrder()

  let currentRoom = createServerRoom({
    config: {
      allowBots: true,
      isPrivate: true,
      isPrivateTableOrigin: true,
      stakeAmount: privateRoom.stake,
    },
  })

  const seatAssignments: Array<{ connectionId: string; seat: Seat }> = []

  privateRoom.members.forEach((member, index) => {
    const seat = shuffledSeats[index]!
    const publicProfile = member.profileId
      ? playerProgressStore.getPublicProfile(member.profileId)
      : null

    const participant = createHumanParticipant({
      connectionId: member.connectionId,
      identity: {
        profileId: member.profileId,
        displayName: member.displayName,
        avatarUrl: member.avatarUrl,
        level: member.level,
        rankTitle: member.rankTitle,
      },
      publicProfile,
    })

    currentRoom = seatParticipantInRoom(currentRoom, seat, participant)
    seatAssignments.push({ connectionId: member.connectionId, seat })
  })

  selectedBotProfiles.forEach((botProfile, index) => {
    const seat = shuffledSeats[privateRoom.members.length + index]!
    const botParticipant = createBotParticipant({
      botProfileId: botProfile.profileId ?? undefined,
      botCode: botProfile.code,
      difficulty: botProfile.difficulty,
      behaviorPreset: botProfile.behaviorPreset,
      logicSource: botProfile.logicSource,
      identity: botProfile.identity,
    })
    currentRoom = seatParticipantInRoom(currentRoom, seat, botParticipant)
  })

  currentRoom = updateRoomHostPlayerId(currentRoom)

  let nextServerState = upsertServerRoom(serverState, currentRoom)

  for (const { connectionId, seat } of seatAssignments) {
    const conn = getConnectionById(nextServerState, connectionId)
    if (conn) {
      const nextConn = attachConnectionToRoomSeat(conn, connectionId, currentRoom, seat)
      nextServerState = updateServerConnectionInState(nextServerState, connectionId, nextConn)
    }
  }

  const initializedRoom = initializeRoomAuthoritativeGameState(currentRoom)

  function notifyMembersExpired(): void {
    for (const member of privateRoom.members) {
      safeSendToConnection(member.connectionId, {
        type: 'private_room_expired',
        privateRoomId: privateRoom.id,
      })
    }
  }

  const ensureResult = activeRoomRuntime.ensureRoom(initializedRoom)
  if (!ensureResult.ok) {
    console.error(
      `[private-room] no runtime capacity for bot-fill room=${initializedRoom.id}: ${ensureResult.reason}`,
    )
    notifyMembersExpired()
    privateRoomChatStore.clearRoom(privateRoom.id)
    return
  }

  if (privateRoom.stake > 0) {
    const stakeResult = matchEconomyStore.collectRoomStakes(initializedRoom, privateRoom.stake)
    if (!stakeResult.ok) {
      console.error(`[private-room] bot-fill stake collection failed room=${initializedRoom.id}: ${stakeResult.message}`)
      activeRoomRuntime.removeRoom(initializedRoom.id)
      notifyMembersExpired()
      privateRoomChatStore.clearRoom(privateRoom.id)
      return
    }

    const botStakeResult = matchEconomyStore.collectBotStakes(initializedRoom, privateRoom.stake)
    if (!botStakeResult.ok) {
      console.error(`[private-room] bot-fill bot-stake collection failed room=${initializedRoom.id}: ${botStakeResult.message}`)
    }
  }

  nextServerState = commitServerRoomWithSnapshot(initializedRoom, nextServerState)
  serverState = nextServerState

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

const privateRoomChatStore = createPrivateRoomChatStore()

const privateRoomsStore = createPrivateRoomsStore({
  onRoomsChanged: () => broadcastPrivateRoomsListToLobbyConnections(),
  onRoomFull: (room) => handlePrivateRoomFull(room),
  onRoomExpired: (room) => handlePrivateRoomExpired(room),
  onRoomClosed: (room) => handlePrivateRoomClosed(room),
  onMemberLeft: (room, member) => handlePrivateRoomMemberLeft(room, member),
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
  reason: 'creator_cancelled' | 'fill_expired',
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
          // Worker-tick batch commits минават покрай commitServerRoomWithSnapshot
          // (виж commitCanonicalRoom по-горе — директен upsertServerRoom), затова
          // feeder score push-ът трябва да се закачи и тук отделно, за да
          // покрие bot auto-play/timer-expiry advances, не само direct
          // submit_play_card handler-и.
          tournamentCoordinator?.notifyFeederScoreProgress(room)

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
          message: 'Отборът ви загуби служебно поради неявяване. Мачът вече е приключил.',
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

  const enrichedProfile = baseProfile && profileId
    ? {
        ...baseProfile,
        likesCount: likeStore.getLikesCount(profileId),
        hasLikedByMe: viewerProfileId ? likeStore.hasLikedRecently(viewerProfileId, profileId) : null,
        isBlockedByMe: viewerProfileId ? blockStore.isBlocked(viewerProfileId, profileId) : null,
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
      session,
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
        session: result.session,
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
      session: {
        ...session,
        profile: result.profile,
      },
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
      session: {
        ...session,
        profile: result.profile,
      },
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
      session: {
        ...session,
        profile: result.profile,
      },
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
      session: {
        ...session,
        profile: result.profile,
      },
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
    session: {
      ...session,
      profile: result.profile,
    },
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
  return profiles.map((p) => ({
    ...p,
    likesCount: p.profileId ? likeStore.getLikesCount(p.profileId) : null,
    hasLikedByMe: p.profileId && currentProfileId
      ? likeStore.hasLikedRecently(currentProfileId, p.profileId)
      : null,
    isBlockedByMe: p.profileId && currentProfileId
      ? blockStore.isBlocked(currentProfileId, p.profileId)
      : null,
  }))
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
    confirmedEntriesCount: entries.filter((e) => e.status === 'confirmed').length,
    reservedPlacesCount,
    completedTeamsCount: teams.filter((t) => t.status !== 'forming').length,
    formingTeamsCount: teams.filter((t) => t.status === 'forming').length,
    viewerProfileId,
    viewerEntryStatus: viewerEntry?.status ?? null,
    viewerEntryJoinedAs: viewerEntry?.joinedAs ?? null,
  })
}

function getSafePublicProfile(profileId: string): { profileId: string | null; displayName: string; avatarUrl: string | null } | null {
  const profile = playerProgressStore.getPublicProfile(profileId)
  if (profile === null) return null
  return { profileId: profile.profileId, displayName: profile.displayName, avatarUrl: profile.avatarUrl }
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
    confirmedEntriesCount: entries.filter((e) => e.status === 'confirmed').length,
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
  return {
    ...base,
    teams: teamDtos,
    myTeam: viewerEntry?.teamId ? teamDtos.find((team) => team.teamId === viewerEntry.teamId) ?? null : null,
    rounds: roundDtos,
    myActiveMatch: viewerProfileId !== null
      ? tournamentCoordinator?.getAssignmentForProfile(viewerProfileId) ?? null
      : null,
    incomingPartnerInvite: incomingPartnerInvite ? inviteToDto(incomingPartnerInvite) : null,
    outgoingPartnerInvite: outgoingPartnerInvite ? inviteToDto(outgoingPartnerInvite) : null,
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

  const tournament = tournamentStore.getTournamentById(tournamentId)
  if (tournament === null) {
    sendJsonResponse(res, 404, { ok: false, message: 'Турнирът не е намерен.' })
    return true
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)
  const viewerProfileId = session?.profile.profileId ?? null
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

  sendJsonResponse(res, 200, {
    ok: true,
    alreadyRefunded: result.alreadyRefunded,
    refundedAmount: result.refundedAmount,
    walletBalance: result.walletBalance,
    tournament: buildTournamentSummaryDto(result.tournament, profileId),
  })
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
    coinPurchaseStore.markPurchaseCanceledByCheckoutSessionId(stripeSession.id)
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

    const result = adminSettingsStore.updateSettings({
      signupBonusYellowCoins: getNumberField(body, 'signupBonusYellowCoins') ?? undefined,
      profileNameChangePrice: getNumberField(body, 'profileNameChangePrice') ?? undefined,
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

    const result = yellowCoinGiftStore.sendGift(profileId, friendshipId, amount)

    if (!result.ok) {
      if ('code' in result) {
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

    sendJsonResponse(res, 200, {
      ok: true,
      gift: result.gift,
      senderProfile: result.senderProfile,
      recipientProfile: result.recipientProfile,
    })
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

  if (
    pathname !== '/api/chat/conversations' &&
    messagesMatch === null &&
    readMatch === null &&
    attachmentMatch === null
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
    sendJsonResponse(res, 200, {
      ok: true,
      conversations: chatStore.listConversations(profileId, onlineProfileIds),
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

// Модерация на общия лайв чат — admin, subadmin ИЛИ chat_admin
// (isLobbyChatModeratorSession проверява ролята НА МОМЕНТА през жива JOIN
// към accounts, виж authStore.getSession). HTTP (не WS), нарочно — за да
// имаме прясна cookie-based сесийна проверка на всяко изтриване, а не роля
// кеширана само при WS handshake-а на дълготрайна връзка.
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

  if (!isLobbyChatModeratorSession(session)) {
    sendJsonResponse(res, 403, {
      ok: false,
      message: 'Нямаш право да триеш съобщения от общия чат.',
    })
    return true
  }

  const messageId = decodeURIComponent(deleteMatch[1]).trim()

  if (messageId.length === 0) {
    sendJsonResponse(res, 400, { ok: false, message: 'Липсва message ID.' })
    return true
  }

  // isLobbyChatModeratorSession гарантира role !== 'player' — типовият predicate
  // стеснява само session (non-null), не и вложеното account.role поле.
  const result = lobbyChatStore.deleteMessage({
    messageId,
    actorAccountId: session.account.accountId,
    actorRoleAtDeletion: session.account.role as 'admin' | 'subadmin' | 'chat_admin' | 'pika_team' | 'top_chat_admin',
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

  const paymentStats = coinPurchaseStore.getAdminPaymentStats()

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

  const result = coinPurchaseStore.getAdminPaymentListByPeriod({
    period: rawPeriod as (typeof ADMIN_PAYMENT_PERIODS)[number],
    limit,
    offset,
  })

  sendJsonResponse(res, 200, {
    ok: true,
    period: rawPeriod,
    purchases: result.rows,
    pagination: {
      limit,
      offset,
      total: result.total,
      hasMore: offset + result.rows.length < result.total,
    },
    summary: {
      totalsByCurrency: result.totalsByCurrency,
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

  const detail = coinPurchaseStore.getAdminPaymentDetail(purchaseId)
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

  if (await handleTournamentsListRequest(req, res, requestUrl.pathname, requestUrl)) {
    return
  }

  if (await handlePendingTournamentPartnerInvitesRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleTournamentPartnerInviteNotificationRequest(req, res, requestUrl.pathname)) {
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

      if (isServerShuttingDown && isShutdownGuardedClientMessage(message)) {
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
          safeSendToConnection(connection.id, {
            type: 'error',
            message: result.message,
          })
          return
        }

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

      if (message.type === 'submit_play_card') {
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

        const result = activeRoomRuntime.submitPlay({
          room,
          seat: latestConnection.currentSeat,
          cardId: message.cardId,
          declarationKeys: message.declarationKeys,
        })

        if (!result.ok) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: result.message,
          })
          return
        }

        handleTrainingRecorderHumanCard(trainingRecorder, room, result.room)
        serverState = commitServerRoomWithSnapshot(result.room)
        activeRoomRuntime.ensureRoom(result.room)
        broadcastRoomSnapshots(result.room, socketRegistry)
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

        safeSendToConnection(connection.id, {
          type: 'room_resumed',
          roomId: result.room.id,
          seat: result.seat,
        })

        broadcastRoomSnapshots(result.room, socketRegistry)
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
        })

        if (!createResult.ok) {
          safeSendToConnection(connection.id, { type: 'error', message: createResult.message })
          return
        }

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

        if (targetPrivateRoom?.kind === 'open') {
          const memberCount = targetPrivateRoom.members.length
          // Seats assigned in order: bottom(0), right(1), top(2), left(3)
          // Team A = bottom+top, Team B = right+left
          // 3rd joiner (top) partners with member[0] (bottom)
          // 4th joiner (left) partners with member[1] (right)
          const futurePartnerProfileId =
            memberCount === 2
              ? (targetPrivateRoom.members[0]?.profileId ?? null)
              : memberCount === 3
                ? (targetPrivateRoom.members[1]?.profileId ?? null)
                : null

          if (futurePartnerProfileId !== null) {
            const joiningId = latestConnection.profileId
            if (
              blockStore.isBlocked(joiningId, futurePartnerProfileId) ||
              blockStore.isBlocked(futurePartnerProfileId, joiningId)
            ) {
              safeSendToConnection(connection.id, {
                type: 'error',
                message: 'Не можеш да влезеш в тази маса поради блокиране.',
              })
              return
            }
          }
        }

        const joinResult = privateRoomsStore.joinRoom({
          privateRoomId: message.privateRoomId,
          connectionId: connection.id,
          profileId: latestConnection.profileId,
          displayName: publicProfile.displayName,
          avatarUrl: publicProfile.avatarUrl,
          level: publicProfile.level,
          rankTitle: publicProfile.rankTitle,
        })

        if (!joinResult.ok) {
          safeSendToConnection(connection.id, { type: 'error', message: joinResult.message })
          return
        }

        sendPrivateRoomUpdateToMembers(joinResult.room)
        return
      }

      if (message.type === 'leave_private_room') {
        const privateRoom = privateRoomsStore.getRoomByConnectionId(connection.id)
        const isHost = privateRoom?.hostConnectionId === connection.id
        const hasOtherMembers = (privateRoom?.members.length ?? 0) > 1

        if (isHost && hasOtherMembers) {
          privateRoomsStore.closeRoom(connection.id)
        } else {
          privateRoomsStore.leaveRoom(connection.id)
          if (privateRoom !== null && !hasOtherMembers) {
            // Room was silently deleted (last member left) — no
            // onRoomClosed/onRoomExpired callback fires for this path, so
            // clear the ephemeral chat here explicitly.
            privateRoomChatStore.clearRoom(privateRoom.id)
          }
        }

        safeSendToConnection(connection.id, {
          type: 'private_room_left',
          privateRoomId: privateRoom?.id ?? '',
        })
        return
      }

      if (message.type === 'fill_private_room_with_bots') {
        const latestConnection = getConnectionById(serverState, connection.id)

        if (latestConnection?.profileId == null) {
          safeSendToConnection(connection.id, { type: 'error', message: 'Трябва да влезеш в профила си.' })
          return
        }

        const fillResult = privateRoomsStore.beginBotFill(connection.id)

        if (!fillResult.ok) {
          safeSendToConnection(connection.id, { type: 'error', message: fillResult.message })
          return
        }

        handlePrivateRoomBotFill(fillResult.room)
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

        const senderMember = room.members.find((m) => m.connectionId === connection.id)

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

        for (const member of room.members) {
          safeSendToConnection(member.connectionId, {
            type: 'private_room_chat_message',
            privateRoomId: room.id,
            ...sendResult.message,
            ...(member.connectionId === connection.id && requestId ? { requestId } : {}),
          })
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
          connectionId: connection.id,
          profileId: latestConnection.profileId,
          displayName: publicProfile.displayName,
          avatarUrl: publicProfile.avatarUrl,
          level: publicProfile.level,
          rankTitle: publicProfile.rankTitle,
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
          if (respondResult.joined) {
            sendPrivateRoomUpdateToMembers(respondResult.room)
          }
          if (hostConn) {
            safeSendToConnection(hostConn.id, {
              type: 'private_room_invite_accepted',
              toDisplayName: publicProfile.displayName,
            })
          }
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

        const history = lobbyChatStore.listRecentMessages(LOBBY_CHAT_HISTORY_LIMIT, excludedSenderProfileIds)

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
        const senderRole = authStore.getAccountRoleForProfile(latestConnection.profileId) ?? 'player'
        const senderIsChatAdmin = senderRole === 'chat_admin'

        const snapshot = lobbyChatStore.insertMessage({
          senderProfileId: latestConnection.profileId,
          senderDisplayName,
          senderIsChatAdmin,
          senderRole,
          body: validation.body,
        })

        lobbyChatLastAnnouncedSeq = Math.max(lobbyChatLastAnnouncedSeq, snapshot.seq)
        recordLobbyChatSentMessage(latestConnection.profileId, validation.body)

        broadcastLobbyChatMessageToLocalSubscribers(snapshot, {
          originatingConnectionId: connection.id,
          requestId,
        })
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

  processMatchmaking()
}, MATCHMAKING_TICK_MS)

const gameRuntimeTickInterval = setInterval(() => {
  if (isServerShuttingDown) {
    return
  }

  void tickRoomGameRuntimes().catch((error) => {
    const safeErrorMessage =
      error instanceof Error ? error.message : String(error)
    console.error('[game-worker-tick] Tick loop failed.', safeErrorMessage)
  })
}, GAME_RUNTIME_TICK_MS)

try {
  tournamentScheduler = await createTournamentScheduler({
    databaseFilePath: databaseBootstrap.databaseFilePath,
    economyStore: tournamentEconomyStore,
    logError: (message, error) => console.error(message, sanitizeErrorMessage(error)),
    notifyEconomyRefunds: (tournamentId, refundedProfiles) => {
      sendTournamentEconomyRefundNotices(tournamentId, 'fill_expired', refundedProfiles)
    },
  })
  tournamentScheduler.start()
  console.log('[tournament-scheduler] Scheduler started')
} catch (error) {
  console.error('[tournament-scheduler] Failed to start scheduler:', sanitizeErrorMessage(error))
}

try {
  tournamentCoordinator = await createTournamentCoordinator({
    databaseFilePath: databaseBootstrap.databaseFilePath,
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
    // Огледало на cleanupInactiveRoomIfNeeded-ото force-remove разклонение.
    closeCompletedRoom: (room) => {
      serverState = removeCommittedServerRoom(room.id)
      cleanupTempBotsFromRoom(room)
      markRoomSnapshotRemoved(room.id)
      activeRoomRuntime.removeRoom(room.id)
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
    monitoringHistoryStore.record(monitoringSampler.getSnapshot())
  }, 60_000)

  monitoringHistoryPurgeIntervalId = setInterval(() => {
    monitoringHistoryStore?.purgeOlderThan(getDefaultRetentionCutoffMs())
  }, 60 * 60 * 1000)

  console.log('[monitoring] History recording started (60s interval, 30d retention)')
} catch (error) {
  console.error('[monitoring] Failed to start history store:', sanitizeErrorMessage(error))
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
