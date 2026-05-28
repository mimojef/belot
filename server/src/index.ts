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
import {
  createCoinPackageStore,
  type CoinPackageStatus,
} from './db/coinPackageStore.js'
import { createBlockStore, BLOCK_LIMIT } from './db/blockStore.js'
import { createLikeStore } from './db/likeStore.js'
import { createMissionStore, type MissionType } from './db/missionStore.js'
import { createCoinPurchaseStore } from './db/coinPurchaseStore.js'
import { createDailyRewardsStore } from './db/dailyRewardsStore.js'
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
} from './matchmaking/matchmakingTypes.js'
import { removeQueueEntryByConnectionId } from './matchmaking/removeQueueEntryByConnectionId.js'
import {
  createMatchmakingBotSelectionSeed,
  selectMatchmakingBotProfiles,
} from './matchmaking/selectMatchmakingBotProfiles.js'
import { tryCreatePendingMatchGroup } from './matchmaking/tryCreatePendingMatchGroup.js'
import { advanceRoomAuthoritativeGame } from './game/advanceRoomAuthoritativeGame.js'
import { initializeRoomAuthoritativeGameState } from './game/initializeRoomAuthoritativeGameState.js'
import { rebaseServerStateToEventAt } from './game/rebaseServerStateToEventAt.js'
import type { ServerAuthoritativeGameState } from './game/serverGameTypes.js'
import {
  ensureRoomGameRuntime,
  getGameRuntimeCountsByPhase,
  removeRoomGameRuntime,
} from './game/roomGameRuntimeRegistry.js'
import { submitHumanBidActionForRoom } from './game/submitHumanBidActionForRoom.js'
import { submitHumanCutIndexForRoom } from './game/submitHumanCutIndexForRoom.js'
import { submitHumanPlayCardForRoom } from './game/submitHumanPlayCardForRoom.js'
import { resumeHumanControlForRoom } from './game/resumeHumanControlForRoom.js'
import { parseClientMessage } from './protocol/parseClientMessage.js'
import { createPrivateRoomsStore } from './game/privateRoomsStore.js'
import type { PrivateRoom, PrivateRoomMember } from './game/privateRoomsStore.js'
import { addHumanToRoom } from './core/addHumanToRoom.js'
import { createRoomWithHumanHost } from './core/createRoomWithHumanHost.js'
import type { PrivateRoomSnapshot } from './protocol/messageTypes.js'

const HOST = '0.0.0.0'
const PORT = Number(process.env.PORT ?? 3001)
const MATCHMAKING_TICK_MS = 250
const EARLY_BOT_FILL_DEBIT_MS = 1700
const GAME_RUNTIME_TICK_MS = 250
const MATCH_PLAYERS_REQUIRED = 4
const MAX_JSON_BODY_BYTES = 15_000_000
const MAX_ORIGINAL_IMAGE_BYTES = 10_000_000
const MAX_PROFILE_GALLERY_IMAGES = 6
const UPLOADS_ROUTE_PREFIX = '/uploads/'
const SERVER_ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPLOADS_ROOT_PATH = join(SERVER_ROOT_PATH, 'uploads')
const AVATAR_UPLOADS_PATH = join(UPLOADS_ROOT_PATH, 'avatars')
const GALLERY_UPLOADS_PATH = join(UPLOADS_ROOT_PATH, 'profile-gallery')

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
setInterval(() => playerProgressStore.refillCatalogBotWallets(), 5 * 60 * 1000)

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

function runSupportCleanup(): void {
  const deleted = supportStore.cleanupInactiveConversations()
  if (deleted > 0) {
    console.log(`[support] Cleanup: deleted ${deleted} messages from inactive resolved conversations`)
  }
}
runSupportCleanup()
setInterval(runSupportCleanup, 24 * 60 * 60 * 1000)

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
  const delay = msUntilNextSofiaMidnight()
  console.log(`[missions] Next midnight rotation in ${Math.round(delay / 60000)} min`)
  setTimeout(() => {
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

function upsertServerRoomWithSnapshot(
  currentServerState: ServerState,
  room: ServerRoom,
): ServerState {
  persistRoomSnapshot(room)
  return upsertServerRoom(currentServerState, room)
}

function updateServerRoomWithSnapshot(
  currentServerState: ServerState,
  roomId: string,
  room: ServerRoom,
): ServerState {
  persistRoomSnapshot(room)
  return updateServerRoomInState(currentServerState, roomId, room)
}

let serverState: ServerState = loadPersistedServerState()
let matchmakingState: MatchmakingState = createInitialMatchmakingState()

const socketRegistry = new Map<ConnectionId, WebSocket>()
const roomGameRuntimeRegistry = new Map<string, ServerGameRuntime>()

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
  nextServerState = upsertServerRoomWithSnapshot(nextServerState, initializedRoom)
  ensureRoomGameRuntime(roomGameRuntimeRegistry, initializedRoom)
  serverState = nextServerState

  if (privateRoom.stake > 0) {
    const stakeResult = matchEconomyStore.collectRoomStakes(initializedRoom, privateRoom.stake)
    if (!stakeResult.ok) {
      console.error(`[private-room] stake collection failed room=${initializedRoom.id}: ${stakeResult.message}`)
    }
  }

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

function schedulePrivateRoomInviteExpiry(
  inviteId: string,
  toProfileId: string,
  expiresAt: number,
): void {
  const delay = Math.max(0, expiresAt - Date.now())
  const timer = setTimeout(() => {
    privateRoomInviteTimers.delete(inviteId)
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
  ensureRoomGameRuntime(roomGameRuntimeRegistry, room)
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
    removeRoomGameRuntime(roomGameRuntimeRegistry, roomId)
    return true
  }

  if (shouldKeepRoomAlive(room, now)) {
    return false
  }

  const nextRooms = { ...serverState.rooms }
  delete nextRooms[roomId]

  serverState = {
    ...serverState,
    rooms: nextRooms,
  }

  cleanupTempBotsFromRoom(room)
  markRoomSnapshotRemoved(roomId)
  removeRoomGameRuntime(roomGameRuntimeRegistry, roomId)
  console.log(`[room-cleanup] removed inactive room=${roomId}`)

  return true
}

function tickRoomGameRuntimes(): void {
  if (roomGameRuntimeRegistry.size === 0) {
    return
  }

  const now = Date.now()
  let nextRooms: ServerState['rooms'] | null = null

  for (const [roomId, runtime] of roomGameRuntimeRegistry.entries()) {
    const room = serverState.rooms[roomId] ?? null

    if (room === null) {
      removeRoomGameRuntime(roomGameRuntimeRegistry, roomId)
      continue
    }

    if (!shouldKeepRoomAlive(room, now)) {
      if (nextRooms === null) {
        nextRooms = {
          ...serverState.rooms,
        }
      }

      delete nextRooms[roomId]
      cleanupTempBotsFromRoom(room)
      markRoomSnapshotRemoved(roomId)
      removeRoomGameRuntime(roomGameRuntimeRegistry, roomId)
      console.log(`[room-cleanup] removed inactive room=${roomId}`)
      continue
    }

    const nextRoom = advanceRoomAuthoritativeGame(room, now)

    const nextRuntime: ServerGameRuntime = {
      ...runtime,
      phase: nextRoom.game.phase ?? runtime.phase,
      updatedAt: now,
      tickCount: runtime.tickCount + 1,
    }

    roomGameRuntimeRegistry.set(roomId, nextRuntime)

    if (nextRoom !== room) {
      persistRoomSnapshot(nextRoom)
      playerProgressStore.recordCompletedMatch(nextRoom)
      missionStore.recordMatchCompletion(nextRoom)
      const payoutResult = matchEconomyStore.payoutMatchWinners(nextRoom)

      if (!payoutResult.ok) {
        console.error(
          `[match-economy] payout failed room=${nextRoom.id}: ${payoutResult.message}`,
        )
      }

      matchEconomyStore.topUpDepletedBotWallets(nextRoom)

      if (nextRooms === null) {
        nextRooms = {
          ...serverState.rooms,
        }
      }

      nextRooms[roomId] = nextRoom
      broadcastRoomSnapshots(nextRoom, socketRegistry)
    }
  }

  if (nextRooms !== null) {
    serverState = {
      ...serverState,
      rooms: nextRooms,
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

  serverState = upsertServerRoomWithSnapshot(serverState, nextRoom)

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

  ensureRoomGameRuntime(roomGameRuntimeRegistry, nextRoom)

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
    serverState = result.serverState

    if (result.room !== null) {
      persistRoomSnapshot(result.room)
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
      safeSendToConnection(entry.connectionId, {
        type: 'matchmaking_status',
        stake: entry.stake,
        queuedPlayers: 1,
        requiredPlayers: MATCH_PLAYERS_REQUIRED,
        countdownEndsAt: entry.expiresAt,
        remainingMs: Math.max(0, entry.expiresAt - earlyDebitNow),
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

    matchmakingState = result.matchmakingState

    if (result.room === null || result.group === null) {
      return
    }

    const initializedRoom = initializeRoomAuthoritativeGameState(result.room)
    let stakeCollectionFailed = false
    const justDebitedConnectionIds = new Set<ConnectionId>()

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
      }
    }

    if (stakeCollectionFailed) {
      cleanupPendingGroup(result.group.groupId)
      broadcastMatchmakingStatusForStake(result.group.stake)
      continue
    }

    const botStakeResult = matchEconomyStore.collectBotStakes(initializedRoom, result.group.stake)
    if (!botStakeResult.ok) {
      console.error(`[match-economy] bot stake collection failed room=${initializedRoom.id}: ${botStakeResult.message}`)
    }

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

    let nextServerState = upsertServerRoomWithSnapshot(serverState, initializedRoom)

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
    ensureRoomGameRuntime(roomGameRuntimeRegistry, initializedRoom)

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
          serverState = updateServerRoomWithSnapshot(serverState, room.id, nextRoom)
          broadcastRoomSnapshots(nextRoom, socketRegistry)
          break
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
  const recipientConn = Object.values(serverState.connections).find(
    (c) => c.profileId === likedProfileId && c.status === 'connected',
  )
  if (recipientConn && likerProfile) {
    safeSendToConnection(recipientConn.id, {
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
    /^\/api\/friends\/([^/]+)\/(accept|reject|remove)$/.exec(pathname)
  const friendGiftMatch = /^\/api\/friends\/([^/]+)\/gift-coins$/.exec(pathname)

  if (
    pathname !== '/api/friends' &&
    pathname !== '/api/friends/request' &&
    friendGiftMatch === null &&
    friendActionMatch === null
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

    const addresseeConn = Object.values(serverState.connections).find(
      (c) => c.profileId === addresseeProfileId && c.status === 'connected',
    )
    const requesterProfile = playerProgressStore.getPublicProfile(profileId)
    if (addresseeConn && requesterProfile) {
      safeSendToConnection(addresseeConn.id, {
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
      sendJsonResponse(res, 400, result)
      return true
    }

    sendJsonResponse(res, 200, {
      ok: true,
      gift: result.gift,
      senderProfile: result.senderProfile,
      recipientProfile: result.recipientProfile,
    })
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
          : friendshipStore.removeRelationship(profileId, friendshipId)

    if (!result.ok) {
      sendJsonResponse(res, 400, result)
      return true
    }

    if (action === 'accept') {
      const newFriend = result.friendships.friends.find((f) => f.friendshipId === friendshipId)
      const requesterProfileId = newFriend?.profile.profileId ?? null
      if (requesterProfileId) {
        const requesterConn = Object.values(serverState.connections).find(
          (c) => c.profileId === requesterProfileId && c.status === 'connected',
        )
        const accepterProfile = playerProgressStore.getPublicProfile(profileId)
        if (requesterConn && accepterProfile) {
          safeSendToConnection(requesterConn.id, {
            type: 'friend_request_accepted',
            fromProfileId: profileId,
            fromDisplayName: accepterProfile.displayName,
            fromAvatarUrl: accepterProfile.avatarUrl,
          })
        }
      }
    }

    sendJsonResponse(res, 200, {
      ok: true,
      friendships: result.friendships,
    })
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

  sendJsonResponse(res, 200, {
    ok: true,
    stats: {
      onlineCount,
      totalProfiles,
      payments: paymentStats,
    },
  })
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
    sendJsonResponse(res, 200, {
      ok: true,
      service: 'belot-v2-server',
      matchmaking: {
        waitMs: MATCHMAKING_WAIT_MS,
        queuedPlayersByStake: getQueueCountsByStake(),
      },
      gameRuntime: {
        activeRooms: roomGameRuntimeRegistry.size,
        roomsByPhase: getGameRuntimeCountsByPhase(roomGameRuntimeRegistry),
      },
    })
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

  if (await handleAdminDailyRewardsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handlePublicRoomsRequest(req, res, requestUrl.pathname)) {
    return
  }

  if (await handleAdminMatchRoomsRequest(req, res, requestUrl.pathname)) {
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

        const result = submitHumanBidActionForRoom(
          room,
          latestConnection.currentSeat,
          message.action,
        )

        if (!result.ok) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: result.message,
          })
          return
        }

        serverState = upsertServerRoomWithSnapshot(serverState, result.room)
        ensureRoomGameRuntime(roomGameRuntimeRegistry, result.room)
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

        const result = submitHumanCutIndexForRoom(
          room,
          latestConnection.currentSeat,
          message.cutIndex,
        )

        if (!result.ok) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: result.message,
          })
          return
        }

        serverState = upsertServerRoomWithSnapshot(serverState, result.room)
        ensureRoomGameRuntime(roomGameRuntimeRegistry, result.room)
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

        const result = submitHumanPlayCardForRoom(
          room,
          latestConnection.currentSeat,
          message.cardId,
          message.declarationKeys,
        )

        if (!result.ok) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: result.message,
          })
          return
        }

        serverState = upsertServerRoomWithSnapshot(serverState, result.room)
        ensureRoomGameRuntime(roomGameRuntimeRegistry, result.room)
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

        const result = resumeHumanControlForRoom(room, latestConnection.currentSeat)

        if (!result.ok) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: result.message,
          })
          return
        }

        serverState = upsertServerRoomWithSnapshot(serverState, result.room)
        ensureRoomGameRuntime(roomGameRuntimeRegistry, result.room)
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

        safeSendToConnection(connection.id, {
          type: 'partner_rating_submitted',
          roomId: message.roomId,
          ratingValue: message.ratingValue,
        })
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
          serverState = upsertServerRoomWithSnapshot(serverState, restartedRoom)
          ensureRoomGameRuntime(roomGameRuntimeRegistry, restartedRoom)
          broadcastRoomSnapshots(restartedRoom, socketRegistry)
        }

        if (allVoted) {
          applyReplayRestart(replayRoom)
        } else {
          const votedRoom: ServerRoom = { ...replayRoom, replayVotes: updatedVotes }
          serverState = upsertServerRoom(serverState, votedRoom)
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
                  serverState = upsertServerRoom(serverState, botLeaveRoom)
                  broadcastRoomSnapshots(botLeaveRoom, socketRegistry)
                  return
                }

                const botVotes = [...latestRoom.replayVotes, botSeat]
                const allSeats = SERVER_SEAT_ORDER.filter((s) => latestRoom.seats[s].participant !== null)
                if (allSeats.every((s) => botVotes.includes(s))) {
                  applyReplayRestart(latestRoom)
                } else {
                  const botVotedRoom: ServerRoom = { ...latestRoom, replayVotes: botVotes }
                  serverState = upsertServerRoom(serverState, botVotedRoom)
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
            if (!leaveRoom.leaveVotes.includes(leaveSeat)) {
              const updatedLeaveRoom: ServerRoom = {
                ...leaveRoom,
                leaveVotes: [...(leaveRoom.leaveVotes ?? []), leaveSeat],
              }
              serverState = upsertServerRoom(serverState, updatedLeaveRoom)
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
            queuedPlayers: getSearchingEntriesByStake(
              matchmakingState.queueEntries,
              existingEntry.stake,
            ).length,
            requiredPlayers: MATCH_PLAYERS_REQUIRED,
            countdownEndsAt: existingEntry.expiresAt,
            remainingMs: Math.max(0, existingEntry.expiresAt - Date.now()),
            previewBotDisplayNames,
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
          queuedPlayers: getSearchingEntriesByStake(
            matchmakingState.queueEntries,
            queuedEntryAfterStakeCollection.stake,
          ).length,
          requiredPlayers: MATCH_PLAYERS_REQUIRED,
          countdownEndsAt: queuedEntryAfterStakeCollection.expiresAt,
          remainingMs: Math.max(0, queuedEntryAfterStakeCollection.expiresAt - Date.now()),
          totalDurationMs: queuedEntryAfterStakeCollection.expiresAt - queuedEntryAfterStakeCollection.joinedAt,
          previewBotDisplayNames,
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

        const disconnectedParticipant = markHumanParticipantDisconnected(
          participant,
          connection.id,
        )
        const nextRoom = updateHumanParticipantInRoom(
          room,
          seat,
          disconnectedParticipant,
        )
        const detachedConnection = detachConnectionFromRoomSeat(
          latestConnection,
          connection.id,
        )

        serverState = updateServerRoomWithSnapshot(serverState, room.id, nextRoom)
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

        serverState = upsertServerRoomWithSnapshot(result.serverState, initializedRoom)
        ensureRoomGameRuntime(roomGameRuntimeRegistry, initializedRoom)

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

        serverState = upsertServerRoomWithSnapshot(result.serverState, initializedRoom)
        ensureRoomGameRuntime(roomGameRuntimeRegistry, initializedRoom)

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
      removeConnectionFromMatchmaking(connection.id)
      privateRoomsStore.removeConnection(connection.id)

      const result = handleDisconnect(serverState, connection.id)

      serverState = result.serverState
      socketRegistry.delete(connection.id)

      let roomWasRemoved = false

      if (result.room !== null) {
        roomWasRemoved = cleanupInactiveRoomIfNeeded(result.room.id)
      }

      if (result.room !== null && !roomWasRemoved) {
        persistRoomSnapshot(result.room)
        broadcastRoomSnapshots(result.room, socketRegistry)
      }

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

setInterval(() => {
  processMatchmaking()
}, MATCHMAKING_TICK_MS)

setInterval(() => {
  try {
    tickRoomGameRuntimes()
  } catch (error) {
    console.error('[game-runtime] tick error', error)
  }
}, GAME_RUNTIME_TICK_MS)

function closeActiveRoomSnapshotStore(): void {
  try {
    activeRoomSnapshotStore.close()
    playerProgressStore.close()
    adminSettingsStore.close()
    authStore.close()
    friendshipStore.close()
    chatStore.close()
    yellowCoinGiftStore.close()
    tableExitPenaltyStore.close()
    matchEconomyStore.close()
    coinPackageStore.close()
    coinPurchaseStore.close()
    dailyRewardsStore.close()
  } catch (error) {
    console.error('[room-snapshot] failed to close store', error)
  }
}

process.once('SIGINT', () => {
  closeActiveRoomSnapshotStore()
  process.exit(0)
})

process.once('SIGTERM', () => {
  closeActiveRoomSnapshotStore()
  process.exit(0)
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
