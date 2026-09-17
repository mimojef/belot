import { randomUUID } from 'node:crypto'
import type { MatchStake } from '../matchmaking/matchmakingTypes.js'

export type LudoRoomPlayer = {
  connectionId: string
  profileId: string
  displayName: string
  avatarUrl: string | null
}

export type LudoRoom = {
  id: string
  stake: MatchStake
  playerCount: 2 | 4
  manualStart: boolean
  hostProfileId: string
  players: LudoRoomPlayer[]
  createdAt: number
}

export type LudoRoomErrorCode =
  | 'ludo_room_not_found'
  | 'ludo_room_full'
  | 'ludo_room_duplicate_member'
  | 'ludo_room_not_host'
  | 'ludo_room_not_full'
  | 'ludo_room_invalid_target'

type Failure = { ok: false; code: LudoRoomErrorCode; message: string }
type Callbacks = {
  onRoomsChanged: () => void
  onRoomReady: (room: LudoRoom) => void
  onMemberKicked: (room: LudoRoom, player: LudoRoomPlayer) => void
}

export function createLudoRoomsStore(callbacks: Callbacks) {
  const rooms = new Map<string, LudoRoom>()
  const connectionToRoom = new Map<string, string>()

  const fail = (code: LudoRoomErrorCode, message: string): Failure => ({ ok: false, code, message })
  const findByConnection = (connectionId: string): LudoRoom | null => {
    const id = connectionToRoom.get(connectionId)
    return id ? rooms.get(id) ?? null : null
  }
  const findByProfile = (profileId: string): LudoRoom | null =>
    [...rooms.values()].find((room) => room.players.some((player) => player.profileId === profileId)) ?? null

  function detachAndStart(room: LudoRoom): void {
    rooms.delete(room.id)
    room.players.forEach((player) => connectionToRoom.delete(player.connectionId))
    callbacks.onRoomsChanged()
    callbacks.onRoomReady(room)
  }

  function createRoom(input: {
    connectionId: string
    profileId: string
    displayName: string
    avatarUrl: string | null
    stake: MatchStake
    playerCount: 2 | 4
    manualStart: boolean
  }): { ok: true; room: LudoRoom } | Failure {
    if (findByConnection(input.connectionId) || findByProfile(input.profileId)) {
      return fail('ludo_room_duplicate_member', 'Вече участваш в Ludo игра.')
    }
    const room: LudoRoom = {
      id: randomUUID(),
      stake: input.stake,
      playerCount: input.playerCount,
      manualStart: input.manualStart,
      hostProfileId: input.profileId,
      players: [{
        connectionId: input.connectionId,
        profileId: input.profileId,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
      }],
      createdAt: Date.now(),
    }
    rooms.set(room.id, room)
    connectionToRoom.set(input.connectionId, room.id)
    callbacks.onRoomsChanged()
    return { ok: true, room }
  }

  function joinRoom(input: {
    roomId: string
    connectionId: string
    profileId: string
    displayName: string
    avatarUrl: string | null
  }): { ok: true; room: LudoRoom; started: boolean } | Failure {
    const room = rooms.get(input.roomId)
    if (!room) return fail('ludo_room_not_found', 'Тази Ludo игра вече не е налична.')
    if (findByProfile(input.profileId) || findByConnection(input.connectionId)) {
      return fail('ludo_room_duplicate_member', 'Вече участваш в Ludo игра.')
    }
    if (room.players.length >= room.playerCount) return fail('ludo_room_full', 'Ludo играта вече е пълна.')

    room.players.push({
      connectionId: input.connectionId,
      profileId: input.profileId,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
    })
    connectionToRoom.set(input.connectionId, room.id)
    const started = !room.manualStart && room.players.length === room.playerCount
    if (started) detachAndStart(room)
    else callbacks.onRoomsChanged()
    return { ok: true, room, started }
  }

  function leaveRoom(connectionId: string): LudoRoom | null {
    const room = findByConnection(connectionId)
    if (!room) return null
    const player = room.players.find((item) => item.connectionId === connectionId)
    connectionToRoom.delete(connectionId)
    room.players = room.players.filter((item) => item.connectionId !== connectionId)
    if (room.players.length === 0) rooms.delete(room.id)
    else if (player?.profileId === room.hostProfileId) room.hostProfileId = room.players[0]!.profileId
    callbacks.onRoomsChanged()
    return rooms.get(room.id) ?? null
  }

  function kickMember(connectionId: string, targetProfileId: string): { ok: true; room: LudoRoom; player: LudoRoomPlayer } | Failure {
    const room = findByConnection(connectionId)
    if (!room) return fail('ludo_room_not_found', 'Не си в Ludo чакалня.')
    const caller = room.players.find((player) => player.connectionId === connectionId)
    if (!caller || caller.profileId !== room.hostProfileId) return fail('ludo_room_not_host', 'Само създателят може да премахва играчи.')
    if (targetProfileId === room.hostProfileId) return fail('ludo_room_invalid_target', 'Създателят не може да премахне себе си.')
    const player = room.players.find((item) => item.profileId === targetProfileId)
    if (!player) return fail('ludo_room_invalid_target', 'Играчът вече не е в стаята.')
    room.players = room.players.filter((item) => item.profileId !== targetProfileId)
    connectionToRoom.delete(player.connectionId)
    callbacks.onRoomsChanged()
    callbacks.onMemberKicked(room, player)
    return { ok: true, room, player }
  }

  function startRoom(connectionId: string): { ok: true; room: LudoRoom } | Failure {
    const room = findByConnection(connectionId)
    if (!room) return fail('ludo_room_not_found', 'Не си в Ludo чакалня.')
    const caller = room.players.find((player) => player.connectionId === connectionId)
    if (!caller || caller.profileId !== room.hostProfileId) return fail('ludo_room_not_host', 'Само създателят може да стартира играта.')
    if (!room.manualStart || room.players.length !== room.playerCount) return fail('ludo_room_not_full', 'Играта може да стартира само когато всички места са заети.')
    detachAndStart(room)
    return { ok: true, room }
  }

  function reconnectMember(connectionId: string, profileId: string): LudoRoom | null {
    const room = findByProfile(profileId)
    if (!room) return null
    const player = room.players.find((item) => item.profileId === profileId)!
    connectionToRoom.delete(player.connectionId)
    player.connectionId = connectionId
    connectionToRoom.set(connectionId, room.id)
    return room
  }

  return {
    createRoom,
    joinRoom,
    leaveRoom,
    kickMember,
    startRoom,
    reconnectMember,
    listRooms: () => [...rooms.values()],
    getRoomByConnectionId: findByConnection,
    removeConnection: (connectionId: string) => { connectionToRoom.delete(connectionId) },
  }
}

export type LudoRoomsStore = ReturnType<typeof createLudoRoomsStore>
