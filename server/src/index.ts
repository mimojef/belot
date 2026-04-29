import { createServer } from 'node:http'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { ensureServerDatabaseReady } from './db/ensureServerDatabaseReady.js'
import { importBotProfilesCatalog } from './db/importBotProfilesCatalog.js'
import { attachConnectionToRoomSeat } from './core/attachConnectionToRoomSeat.js'
import { broadcastRoomSnapshots } from './core/broadcastRoomSnapshots.js'
import { createInitialServerState } from './core/createInitialServerState.js'
import { createServerConnection } from './core/createServerConnection.js'
import { getConnectionById } from './core/getConnectionById.js'
import { handleCreateRoom } from './core/handleCreateRoom.js'
import { handleDisconnect } from './core/handleDisconnect.js'
import { handleJoinRoom } from './core/handleJoinRoom.js'
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
import {
  createReconnectedHumanParticipant,
  findHumanParticipantByReconnectToken,
  type ServerGameRuntime,
  shouldKeepRoomAlive,
} from './core/serverGameRuntimeHelpers.js'
import { updateConnectionHeartbeat } from './core/updateConnectionHeartbeat.js'
import { updateHumanParticipantInRoom } from './core/updateHumanParticipantInRoom.js'
import { updateServerConnectionInState } from './core/updateServerConnectionInState.js'
import { upsertServerConnection } from './core/upsertServerConnection.js'
import { upsertServerRoom } from './core/upsertServerRoom.js'
import { addQueueEntry } from './matchmaking/addQueueEntry.js'
import { createInitialMatchmakingState } from './matchmaking/createInitialMatchmakingState.js'
import { createMatchmakingQueueEntry } from './matchmaking/createMatchmakingQueueEntry.js'
import { getQueueEntryByConnectionId } from './matchmaking/getQueueEntryByConnectionId.js'
import { getSearchingEntriesByStake } from './matchmaking/getSearchingEntriesByStake.js'
import type { MatchmakingState } from './matchmaking/matchmakingState.js'
import {
  MATCHMAKING_WAIT_MS,
  SUPPORTED_MATCH_STAKES,
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
import {
  ensureRoomGameRuntime,
  getGameRuntimeCountsByPhase,
  removeRoomGameRuntime,
} from './game/roomGameRuntimeRegistry.js'
import { submitHumanBidActionForRoom } from './game/submitHumanBidActionForRoom.js'
import { submitHumanCutIndexForRoom } from './game/submitHumanCutIndexForRoom.js'
import { submitHumanPlayCardForRoom } from './game/submitHumanPlayCardForRoom.js'
import { parseClientMessage } from './protocol/parseClientMessage.js'

const HOST = '0.0.0.0'
const PORT = Number(process.env.PORT ?? 3001)
const MATCHMAKING_TICK_MS = 250
const GAME_RUNTIME_TICK_MS = 250
const MATCH_PLAYERS_REQUIRED = 4

const databaseBootstrap = await ensureServerDatabaseReady()
const botCatalogImport = await importBotProfilesCatalog(
  databaseBootstrap.databaseFilePath,
)

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

let serverState: ServerState = createInitialServerState()
let matchmakingState: MatchmakingState = createInitialMatchmakingState()

const socketRegistry = new Map<ConnectionId, WebSocket>()
const roomGameRuntimeRegistry = new Map<string, ServerGameRuntime>()

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

function cleanupInactiveRoomIfNeeded(roomId: string, now: number = Date.now()): boolean {
  const room = serverState.rooms[roomId] ?? null

  if (room === null) {
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

  serverState = upsertServerRoom(serverState, nextRoom)

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
    averageRating: null,
    totalRatingsCount: null,
    yellowCoinsBalance: null,
    galleryImages: [],
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

  safeSendToConnection(connectionId, {
    type: 'player_profile',
    roomId,
    seat,
    profile:
      participant === null
        ? null
        : participant.publicProfile ?? createFallbackPublicProfileSnapshot(participant),
  })
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
  const previewBotDisplayNames = selectMatchmakingBotProfiles({
    stake,
    count: Math.max(0, MATCH_PLAYERS_REQUIRED - searchingEntries.length),
    selectionSeed: createMatchmakingBotSelectionSeed(stake, searchingEntries),
  }).map((profile) => profile.identity.displayName)

  safeSendToConnection(connectionId, {
    type: 'matchmaking_status',
    stake,
    queuedPlayers: searchingEntries.length,
    requiredPlayers: MATCH_PLAYERS_REQUIRED,
    countdownEndsAt,
    remainingMs: Math.max(0, countdownEndsAt - now),
    previewBotDisplayNames,
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
  let guard = 0

  while (guard < 20) {
    guard += 1

    const result = tryCreatePendingMatchGroup(matchmakingState)

    matchmakingState = result.matchmakingState

    if (result.room === null || result.group === null) {
      return
    }

    const initializedRoom = initializeRoomAuthoritativeGameState(result.room)
    let nextServerState = upsertServerRoom(serverState, initializedRoom)

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

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
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
      }),
    )
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(
    JSON.stringify({
      ok: false,
      message: 'Not found',
    }),
  )
})

const wsServer = new WebSocketServer({
  server: httpServer,
  path: '/ws',
})

wsServer.on('connection', (socket, request) => {
  const connection = createServerConnection({
    remoteAddress: request.socket.remoteAddress ?? null,
    userAgent:
      typeof request.headers['user-agent'] === 'string'
        ? request.headers['user-agent']
        : null,
  })

  serverState = upsertServerConnection(serverState, connection)
  socketRegistry.set(connection.id, socket)

  console.log(
    `[ws] client connected: ${connection.id} (${connection.remoteAddress ?? 'unknown'})`,
  )

  sendJsonMessage(socket, {
    type: 'connected',
    clientId: connection.id,
    message: 'Connected to Belot V2 server.',
  })

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

        serverState = upsertServerRoom(serverState, result.room)
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

        serverState = upsertServerRoom(serverState, result.room)
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
        )

        if (!result.ok) {
          safeSendToConnection(connection.id, {
            type: 'error',
            message: result.message,
          })
          return
        }

        serverState = upsertServerRoom(serverState, result.room)
        ensureRoomGameRuntime(roomGameRuntimeRegistry, result.room)
        broadcastRoomSnapshots(result.room, socketRegistry)
        return
      }

      if (message.type === 'resume_room') {
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
          throw new Error(
            `Connection "${connection.id}" is already attached to room "${latestConnection.currentRoomId}".`,
          )
        }

        const stablePlayerConnection = {
          ...latestConnection,
          playerId: latestConnection.playerId ?? latestConnection.id,
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
          matchmakingState = {
            ...matchmakingState,
            queueEntries: removeQueueEntryByConnectionId(
              matchmakingState.queueEntries,
              connection.id,
            ),
          }

          broadcastMatchmakingStatusForStake(existingEntry.stake)
        }

        const nextEntry = createMatchmakingQueueEntry({
          connectionId: connection.id,
          playerId: stablePlayerConnection.playerId ?? stablePlayerConnection.id,
          displayName: message.displayName ?? 'Гост',
          stake: message.stake,
        })

        matchmakingState = {
          ...matchmakingState,
          queueEntries: addQueueEntry(matchmakingState.queueEntries, nextEntry),
        }

        const searchingEntries = getSearchingEntriesByStake(
          matchmakingState.queueEntries,
          nextEntry.stake,
        ).sort((a, b) => a.joinedAt - b.joinedAt)
        const previewBotDisplayNames = selectMatchmakingBotProfiles({
          stake: nextEntry.stake,
          count: Math.max(0, MATCH_PLAYERS_REQUIRED - searchingEntries.length),
          selectionSeed: createMatchmakingBotSelectionSeed(
            nextEntry.stake,
            searchingEntries,
          ),
        }).map((profile) => profile.identity.displayName)

        safeSendToConnection(connection.id, {
          type: 'matchmaking_joined',
          stake: nextEntry.stake,
          queuedPlayers: getSearchingEntriesByStake(
            matchmakingState.queueEntries,
            nextEntry.stake,
          ).length,
          requiredPlayers: MATCH_PLAYERS_REQUIRED,
          countdownEndsAt: nextEntry.expiresAt,
          remainingMs: Math.max(0, nextEntry.expiresAt - Date.now()),
          previewBotDisplayNames,
        })

        broadcastMatchmakingStatusForStake(nextEntry.stake)
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

      if (message.type === 'create_room') {
        removeConnectionFromMatchmaking(connection.id)

        const result = handleCreateRoom(
          serverState,
          connection.id,
          message.displayName,
        )

        const initializedRoom = initializeRoomAuthoritativeGameState(result.room)

        serverState = upsertServerRoom(result.serverState, initializedRoom)
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

        const result = handleJoinRoom(
          serverState,
          connection.id,
          message.roomId,
          message.displayName,
        )

        const initializedRoom = initializeRoomAuthoritativeGameState(result.room)

        serverState = upsertServerRoom(result.serverState, initializedRoom)
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

      const result = handleDisconnect(serverState, connection.id)

      serverState = result.serverState
      socketRegistry.delete(connection.id)

      let roomWasRemoved = false

      if (result.room !== null) {
        roomWasRemoved = cleanupInactiveRoomIfNeeded(result.room.id)
      }

      if (result.room !== null && !roomWasRemoved) {
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
  try {
    processMatchmaking()
  } catch (error) {
    console.error('[matchmaking] processing error', error)
  }
}, MATCHMAKING_TICK_MS)

setInterval(() => {
  try {
    tickRoomGameRuntimes()
  } catch (error) {
    console.error('[game-runtime] tick error', error)
  }
}, GAME_RUNTIME_TICK_MS)

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
