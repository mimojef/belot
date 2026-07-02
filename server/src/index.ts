import 'dotenv/config'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import Stripe from 'stripe'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { createActiveRoomSnapshotStore } from './db/activeRoomSnapshotStore.js'
import { createAdminSettingsStore } from './db/adminSettingsStore.js'
import {
  createAuthStore,
  createClearSessionCookieHeader,
  createSessionCookieHeader,
  getSessionTokenFromCookieHeader,
} from './db/authStore.js'
import { createChatStore } from './db/chatStore.js'
import { createSupportStore, type SupportMessageSnapshot, type SupportConversationSnapshot } from './db/supportStore.js'
import { createGuestContactStore } from './db/guestContactStore.js'
import {
  createCoinPackageStore,
  type CoinPackageStatus,
} from './db/coinPackageStore.js'
import { createBlockStore, BLOCK_LIMIT } from './db/blockStore.js'
import { createLikeStore } from './db/likeStore.js'
import { createMissionStore, type MissionType } from './db/missionStore.js'
import { createCoinPurchaseStore } from './db/coinPurchaseStore.js'
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
import { importBotProfilesCatalog } from './db/importBotProfilesCatalog.js'
import { createMatchEconomyStore, setMatchPrizeResolver } from './db/matchEconomyStore.js'
import { createMatchRoomsStore } from './db/matchRoomsStore.js'
import { createPlayerProgressStore } from './db/playerProgressStore.js'
import { createTableExitPenaltyStore } from './db/tableExitPenaltyStore.js'
import { createYellowCoinGiftStore } from './db/yellowCoinGiftStore.js'
import { attachConnectionToRoomSeat } from './core/attachConnectionToRoomSeat.js'
import { broadcastRoomSnapshots } from './core/broadcastRoomSnapshots.js'
import { countServerRoomsByPhase } from './core/countServerRoomsByPhase.js'
import { createInitialServerState } from './core/createInitialServerState.js'
import { createServerConnection } from './core/createServerConnection.js'
import { detachConnectionFromRoomSeat } from './core/detachConnectionFromRoomSeat.js'
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
import { createPrivateRoomsStore } from './game/privateRoomsStore.js'
import type { PrivateRoom, PrivateRoomMember } from './game/privateRoomsStore.js'
import { addHumanToRoom } from './core/addHumanToRoom.js'
import { createRoomWithHumanHost } from './core/createRoomWithHumanHost.js'
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
const MAX_ORIGINAL_IMAGE_BYTES = 10_000_000
const MAX_PROFILE_GALLERY_IMAGES = 6
const UPLOADS_ROUTE_PREFIX = '/uploads/'
const SERVER_ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPLOADS_ROOT_PATH = join(SERVER_ROOT_PATH, 'uploads')
const AVATAR_UPLOADS_PATH = join(UPLOADS_ROOT_PATH, 'avatars')
const GALLERY_UPLOADS_PATH = join(UPLOADS_ROOT_PATH, 'profile-gallery')
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
const chatStore = await createChatStore(
  databaseBootstrap.databaseFilePath,
  playerProgressStore,
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
  return commitServerRoomReplacement(room, currentServerState)
}

function removeCommittedServerRoom(
  roomId: string,
  currentServerState: ServerState = serverState,
): ServerState {
  const nextRooms = { ...currentServerState.rooms }
  delete nextRooms[roomId]
  roomRevisionRegistry.remove(roomId)
  return {
    ...currentServerState,
    rooms: nextRooms,
  }
}

let serverState: ServerState = loadPersistedServerState()
const roomRevisionRegistry = createRoomRevisionRegistry()

for (const room of Object.values(serverState.rooms)) {
  roomRevisionRegistry.ensure(room.id)
}

let matchmakingState: MatchmakingState = createInitialMatchmakingState()
let matchmakingCapacityRetryAt = 0

const socketRegistry = new Map<ConnectionId, WebSocket>()
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

function sendPrivateRoomUpdateToMembers(room: PrivateRoom): void {
  const snapshot = buildPrivateRoomSnapshot(room)
  for (const member of room.members) {
    safeSendToConnection(member.connectionId, { type: 'private_room_updated', room: snapshot })
  }
}

function handlePrivateRoomFull(privateRoom: PrivateRoom): void {
  const [hostMember, ...restMembers] = privateRoom.members

  const hostPublicProfile = hostMember.profileId
    ? playerProgressStore.getPublicProfile(hostMember.profileId)
    : null

  const roomResult = createRoomWithHumanHost({
    connectionId: hostMember.connectionId,
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
      stakeAmount: privateRoom.stake,
    },
  })

  let currentRoom = roomResult.room
  let nextServerState = upsertServerRoom(serverState, currentRoom)

  const hostConn = getConnectionById(nextServerState, hostMember.connectionId)
  if (hostConn) {
    const nextHostConn = attachConnectionToRoomSeat(hostConn, hostMember.connectionId, currentRoom, roomResult.seat)
    nextServerState = updateServerConnectionInState(nextServerState, hostMember.connectionId, nextHostConn)
  }

  const seatAssignments: Array<{ connectionId: string; seat: Seat }> = [
    { connectionId: hostMember.connectionId, seat: roomResult.seat },
  ]

  for (const member of restMembers) {
    const publicProfile = member.profileId
      ? playerProgressStore.getPublicProfile(member.profileId)
      : null

    const addResult = addHumanToRoom(currentRoom, {
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

    currentRoom = addResult.room
    nextServerState = updateServerRoomInState(nextServerState, currentRoom.id, currentRoom)

    const memberConn = getConnectionById(nextServerState, member.connectionId)
    if (memberConn) {
      const nextMemberConn = attachConnectionToRoomSeat(memberConn, member.connectionId, currentRoom, addResult.seat)
      nextServerState = updateServerConnectionInState(nextServerState, member.connectionId, nextMemberConn)
      seatAssignments.push({ connectionId: member.connectionId, seat: addResult.seat })
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
}

function handlePrivateRoomExpired(room: PrivateRoom): void {
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
          runMatchCompletionSideEffect(
            'top-up-depleted-bot-wallets',
            room.id,
            () => {
              matchEconomyStore.topUpDepletedBotWallets(room)
            },
          )
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

      if (participant?.kind === 'human' && participantProfileId === profileId) {
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

function getPartnerSeat(seat: Seat): Seat {
  if (seat === 'bottom') return 'top'
  if (seat === 'top') return 'bottom'
  if (seat === 'left') return 'right'
  return 'left'
}

function shouldApplyTableExitPenalty(room: ServerRoom): boolean {
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
}): void {
  if (isProfileInActiveGame(input.recipientProfileId)) {
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

  if (buffer.length === 0 || buffer.length > MAX_ORIGINAL_IMAGE_BYTES) {
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

async function createCroppedAvatarWebp(input: {
  imageBuffer: Buffer
  cropX: number
  cropY: number
  cropSize: number
}): Promise<Buffer | null> {
  const metadata = await sharp(input.imageBuffer).metadata()
  const imageWidth = metadata.width ?? 0
  const imageHeight = metadata.height ?? 0

  if (imageWidth <= 0 || imageHeight <= 0) {
    return null
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
    return null
  }

  return await sharp(input.imageBuffer)
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
}

async function createGalleryImageWebp(imageBuffer: Buffer): Promise<Buffer | null> {
  const metadata = await sharp(imageBuffer).metadata()
  const imageWidth = metadata.width ?? 0
  const imageHeight = metadata.height ?? 0

  if (imageWidth <= 0 || imageHeight <= 0) {
    return null
  }

  return await sharp(imageBuffer)
    .rotate()
    .resize(800, 800, {
      fit: 'cover',
      position: 'centre',
      withoutEnlargement: false,
    })
    .webp({ quality: 80 })
    .toBuffer()
}

function resolveUploadRequestPath(pathname: string): string | null {
  if (!pathname.startsWith(UPLOADS_ROUTE_PREFIX)) {
    return null
  }

  const relativePath = decodeURIComponent(
    pathname.slice(UPLOADS_ROUTE_PREFIX.length),
  )
  const resolvedPath = resolve(UPLOADS_ROOT_PATH, relativePath)
  const uploadsRoot = `${resolve(UPLOADS_ROOT_PATH)}${/[/\\]$/.test(UPLOADS_ROOT_PATH) ? '' : '\\'}`

  if (!resolvedPath.startsWith(uploadsRoot) && resolvedPath !== resolve(UPLOADS_ROOT_PATH)) {
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

  if (session?.account.role !== 'admin') {
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

  if (session?.account.role !== 'admin') {
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

  if (session?.account.role !== 'admin') {
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

  if (session?.account.role !== 'admin') {
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
  const available = name.trim().length >= 3 && playerProgressStore.isDisplayNameAvailable(name)
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
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Изпрати валидна снимка и избери квадрат за аватар.',
      })
      return true
    }

    const avatarBuffer = await createCroppedAvatarWebp({
      imageBuffer,
      cropX,
      cropY,
      cropSize,
    })

    if (avatarBuffer === null) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Избраният квадрат е извън снимката.',
      })
      return true
    }

    const oldAvatarUrl = session.profile.avatarUrl
    const avatarFilename = `${randomUUID()}.webp`

    await writeWebpUploadFile(
      AVATAR_UPLOADS_PATH,
      avatarFilename,
      avatarBuffer,
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
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Изпрати валидна снимка до 5 MB.',
      })
      return true
    }

    const galleryBuffer = await createGalleryImageWebp(imageBuffer)

    if (galleryBuffer === null) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Снимката не можа да бъде обработена.',
      })
      return true
    }

    const imageId = randomUUID()
    const profileGalleryPath = join(
      GALLERY_UPLOADS_PATH,
      session.profile.profileId,
    )

    await writeWebpUploadFile(profileGalleryPath, `${imageId}.webp`, galleryBuffer)

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

async function handlePlayersRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
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

  const all = playerProgressStore.listPublicHumanProfiles(onlineProfileIds)

  const me = currentProfileId ? all.filter((p) => p.profileId === currentProfileId) : []
  const humans = all.filter((p) => !p.isBot && p.profileId !== currentProfileId)
  const bots = all.filter((p) => p.isBot === true)

  // Fisher-Yates shuffle
  function shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
  }

  const allPlayers = [...me, ...shuffle(humans), ...shuffle(bots)].map((p) => ({
    ...p,
    likesCount: p.profileId ? likeStore.getLikesCount(p.profileId) : null,
    hasLikedByMe: p.profileId && currentProfileId
      ? likeStore.hasLikedRecently(currentProfileId, p.profileId)
      : null,
    isBlockedByMe: p.profileId && currentProfileId
      ? blockStore.isBlocked(currentProfileId, p.profileId)
      : null,
  }))

  sendJsonResponse(res, 200, { ok: true, players: allPlayers })
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
      } else if (result.alreadyCredited) {
        console.log(
          `[stripe/webhook] already credited session=${checkoutSessionId} purchaseId=${purchaseId}`,
        )
      } else {
        console.log(
          `[stripe/webhook] fulfilled purchaseId=${result.purchase.purchaseId} coins=${result.purchase.yellowCoinsAmount}`,
        )
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

  if (session === null || session.account.role !== 'admin') {
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
  const deleteMatch = /^\/api\/admin\/coin-packages\/([^/]+)$/.exec(pathname)

  if (
    pathname !== '/api/admin/coin-packages' &&
    statusMatch === null &&
    lobbyMatch === null &&
    deleteMatch === null
  ) {
    return false
  }

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

  if (session === null || session.account.role !== 'admin') {
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

  if (pathname !== '/api/chat/conversations' && messagesMatch === null && readMatch === null) {
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
    const body = await readJsonRequestBody(req)

    if (!isRecord(body)) {
      sendJsonResponse(res, 400, {
        ok: false,
        message: 'Invalid request body.',
      })
      return true
    }

    const result = chatStore.sendMessage(
      profileId,
      friendshipId,
      getStringField(body, 'body'),
    )

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    const recipientProfileId = result.conversation.friend.profileId

    if (recipientProfileId !== null) {
      sendChatNotificationToProfile({
        recipientProfileId,
        friendshipId,
        senderProfileId: profileId,
      })
    }

    sendJsonResponse(res, 200, {
      ok: true,
      conversation: result.conversation,
      messages: result.messages,
    })
    return true
  }

  return false
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

  if (session === null || session.account.role !== 'admin') {
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

  if (session?.account.role !== 'admin') {
    sendJsonResponse(res, 403, { ok: false, message: 'Forbidden' })
    return true
  }

  const onlineCount = Object.values(serverState.connections).filter(
    (c) => c.status === 'connected' && socketRegistry.get(c.id)?.readyState === WebSocket.OPEN,
  ).length

  const totalProfiles = playerProgressStore.countHumanProfiles()

  const paymentStats = coinPurchaseStore.getAdminPaymentStats()

  const visitors = siteVisitStore.getVisitorSummary()
  const viewLayout = siteVisitStore.getViewLayoutSummary()

  sendJsonResponse(res, 200, {
    ok: true,
    stats: {
      onlineCount,
      totalProfiles,
      payments: paymentStats,
      visitors,
      viewLayout,
    },
  })
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

  if (session?.account.role !== 'admin') {
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

  if (session?.account.role !== 'admin') {
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

  if (session?.account.role !== 'admin') {
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

async function handleAdminMatchRoomsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const deleteMatch = /^\/api\/admin\/rooms\/(\d+)$/.exec(pathname)

  if (pathname !== '/api/admin/rooms' && deleteMatch === null) return false

  const session = authStore.getSession(getSessionTokenFromCookieHeader(req.headers.cookie))
  if (!session || session.account.role !== 'admin') {
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

async function handleSupportRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/support')) return false

  const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)
  const session = authStore.getSession(sessionToken)

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
    const rawBody = await readRawRequestBody(req)
    const parsed = JSON.parse(rawBody.toString()) as { body?: string; website?: string }

    // Honeypot — bots fill hidden fields
    if (parsed.website) {
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

    const text = typeof parsed.body === 'string' ? parsed.body.trim() : ''
    if (text.length === 0 || text.length > 2000) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалидно съобщение.' })
      return true
    }
    const message = supportStore.sendUserMessage(profileId, text)
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
    const unreadCount = session.account.role === 'admin'
      ? supportStore.getTotalUnreadForAdmin()
      : supportStore.getUnreadCountForUser(session.profile.profileId)
    sendJsonResponse(res, 200, { ok: true, unreadCount })
    return true
  }

  // GET /api/support/admin/conversations — admin sees all
  if (pathname === '/api/support/admin/conversations' && req.method === 'GET') {
    if (session?.account.role !== 'admin') {
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

  // GET /api/support/admin/messages/:profileId — admin reads thread
  if (pathname.startsWith('/api/support/admin/messages/') && req.method === 'GET') {
    if (session?.account.role !== 'admin') {
      sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
      return true
    }
    const profileId = pathname.replace('/api/support/admin/messages/', '')
    const messages = supportStore.getMessages(profileId)
    supportStore.markReadByAdmin(profileId)
    sendJsonResponse(res, 200, { ok: true, messages })
    return true
  }

  // POST /api/support/admin/reply — admin replies
  if (pathname === '/api/support/admin/reply' && req.method === 'POST') {
    if (session?.account.role !== 'admin') {
      sendJsonResponse(res, 403, { ok: false, message: 'Нямаш права.' })
      return true
    }
    const rawBody = await readRawRequestBody(req)
    const parsed = JSON.parse(rawBody.toString()) as { profileId?: string; body?: string }
    const profileId = typeof parsed.profileId === 'string' ? parsed.profileId.trim() : ''
    const text = typeof parsed.body === 'string' ? parsed.body.trim() : ''
    if (!profileId || text.length === 0 || text.length > 2000) {
      sendJsonResponse(res, 400, { ok: false, message: 'Невалидни данни.' })
      return true
    }
    const message = supportStore.sendAdminReply(profileId, text)
    if (!message) {
      sendJsonResponse(res, 404, { ok: false, message: 'Потребителят няма съобщения.' })
      return true
    }
    const messages = supportStore.getMessages(profileId)
    sendJsonResponse(res, 200, { ok: true, message, messages })
    return true
  }

  // POST /api/support/admin/conversations/:profileId/archive — admin archives thread
  if (pathname.match(/^\/api\/support\/admin\/conversations\/[^/]+\/archive$/) && req.method === 'POST') {
    if (session?.account.role !== 'admin') {
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

  // DELETE /api/support/admin/conversations/:profileId — admin hard-deletes thread
  if (pathname.startsWith('/api/support/admin/conversations/') && req.method === 'DELETE') {
    if (session?.account.role !== 'admin') {
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
      roomShadowSync: roomShadowSynchronizer?.getHealth() ?? null,
      gameWorkerPool: poolHealth,
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

  if (await handleFriendsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleChatRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleProfileLikeRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleProfileBlockRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handlePlayersRequest(req, res, requestUrl.pathname)) {
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

  if (await handleShopPurchasesRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleShopCheckoutRequest(req, res, requestUrl.pathname)) {
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
        }
        const disconnectedRoom = updateHumanParticipantInRoom(
          roomWithLeaveVote,
          seat,
          disconnectedParticipant,
        )
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
        })

        if (!createResult.ok) {
          safeSendToConnection(connection.id, { type: 'error', message: createResult.message })
          return
        }

        safeSendToConnection(connection.id, {
          type: 'private_room_updated',
          room: buildPrivateRoomSnapshot(createResult.room),
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
        }

        safeSendToConnection(connection.id, {
          type: 'private_room_left',
          privateRoomId: privateRoom?.id ?? '',
        })
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

// ─── Monitoring sampler ───────────────────────────────────────────────────────

try {
  monitoringSampler = createMonitoringSampler({
    backendStartedAtMs,
    getWsConnectionCount: () => countOpenWebSockets(socketRegistry),
    getUniqueOnlineRealPlayers: () => countUniqueOnlineRealPlayers(serverState.connections),
    getMatchmakingWaitersByStake: () => getQueueCountsByStake(),
    getActiveRoomCount: () => Object.keys(serverState.rooms).length,
    getRoomsByPhase: () => countServerRoomsByPhase(serverState.rooms),
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

  clearPrivateRoomInviteTimers()
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
  closeStore('yellowCoinGiftStore', () => yellowCoinGiftStore.close())
  closeStore('tableExitPenaltyStore', () => tableExitPenaltyStore.close())
  closeStore('matchEconomyStore', () => matchEconomyStore.close())
  closeStore('coinPackageStore', () => coinPackageStore.close())
  closeStore('coinPurchaseStore', () => coinPurchaseStore.close())
  closeStore('dailyRewardsStore', () => dailyRewardsStore.close())
  closeStore('siteVisitStore', () => siteVisitStore.close())

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
